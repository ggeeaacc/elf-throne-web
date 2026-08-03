/**
 * 房间注册表与会话（ADR-004）。零规则——只装配 config、鉴权转发、投影分发。
 */
import { randomBytes } from 'node:crypto';
import {
  activeCharactersFor,
  applyCommand,
  beginGame,
  createInitialState,
  EngineError,
  projectEvents,
  projectView,
} from '@elf-throne/engine';
import type {
  CharacterId,
  Command,
  GameConfig,
  GameState,
  PlayerCount,
} from '@elf-throne/engine';
import type { CharacterId as CId } from '@elf-throne/engine';
import type { RoomSnapshot } from './protocol.js';
import { AiDriver } from './ai.js';

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去 0O1IL

export interface Player {
  id: string;
  name: string;
  token: string;
  seat: number;
  connected: boolean;
  /** AI 托管座位：无真实 ws 连接，由服务端 AiDriver 驱动 */
  isAI?: boolean;
  /** 由 session 层注入的发送通道 */
  send: (msg: unknown) => void;
}

export interface Room {
  id: string;
  status: 'lobby' | 'playing' | 'finished';
  hostPlayerId: string;
  players: Map<string, Player>;
  state: GameState | null;
  seq: number;
  /** 座位→角色选角（lobby 期间；seatAssignments 优先） */
  characterSelections: Record<number, CharacterId>;
}

export class RoomError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

export class RoomRegistry {
  private rooms = new Map<string, Room>();
  private ai = new AiDriver({
    broadcastViews: (room, events) => this.broadcastViews(room, events),
    broadcastLog: (room, text) => this.broadcastLog(room, text),
    markFinished: (room) => {
      room.status = 'finished';
    },
  });

  createRoom(name: string, send: (msg: unknown) => void): { room: Room; player: Player } {
    const id = this.newRoomId();
    const player = this.newPlayer(name, 0, send);
    const room: Room = {
      id,
      status: 'lobby',
      hostPlayerId: player.id,
      players: new Map([[player.id, player]]),
      state: null,
      seq: 0,
      characterSelections: {},
    };
    this.rooms.set(id, room);
    return { room, player };
  }

  joinRoom(roomId: string, name: string, send: (msg: unknown) => void): { room: Room; player: Player } {
    const room = this.mustGet(roomId);
    if (room.status !== 'lobby') throw new RoomError('room_not_in_lobby', '对局已开始，不能加入');
    if (room.players.size >= 4) throw new RoomError('room_full', '房间已满');
    const seat = room.players.size;
    const player = this.newPlayer(name, seat, send);
    room.players.set(player.id, player);
    return { room, player };
  }

  rejoin(roomId: string, token: string, send: (msg: unknown) => void): { room: Room; player: Player } {
    const room = this.mustGet(roomId);
    const player = [...room.players.values()].find((p) => p.token === token);
    if (!player) throw new RoomError('bad_token', '身份令牌无效');
    player.send = send;
    player.connected = true;
    return { room, player };
  }

  markDisconnected(room: Room, player: Player): void {
    player.connected = false;
    this.broadcastRoom(room);
  }

  /** 全角色池（4P 时全员可用；3P 时 startGame 会按 bench 过滤） */
  private static ALL_CHAR_POOL: CharacterId[] = ['xiaoyu', 'liya', 'kaier', 'baye'];

  /** 主机在大厅给空座位添加 AI 补位（无 ws 连接，服务端托管） */
  addAI(room: Room, byPlayer: Player): void {
    if (room.hostPlayerId !== byPlayer.id) throw new RoomError('not_host', '仅主机可添加 AI');
    if (room.status !== 'lobby') throw new RoomError('already_started', '对局已开始');
    if (room.players.size >= 4) throw new RoomError('room_full', '房间已满');
    const seat = room.players.size;
    const player: Player = {
      id: randomBytes(8).toString('hex'),
      name: `AI 补位·座${seat}`,
      token: randomBytes(16).toString('hex'),
      seat,
      connected: false,
      isAI: true,
      send: () => {},
    };
    room.players.set(player.id, player);
    // AI 自动选角：从未被选中的角色池中取第一个
    const taken = new Set(Object.values(room.characterSelections));
    const auto = RoomRegistry.ALL_CHAR_POOL.find((c) => !taken.has(c));
    if (auto) room.characterSelections[seat] = auto;
    this.broadcastRoom(room);
  }

  /** 主机在大厅移除 AI 座位（仅剩真人不可移除、AI 可移除；移除后按加入顺序重排座位号） */
  removeAI(room: Room, byPlayer: Player, seat: number): void {
    if (room.hostPlayerId !== byPlayer.id) throw new RoomError('not_host', '仅主机可移除 AI');
    if (room.status !== 'lobby') throw new RoomError('already_started', '对局已开始');
    const target = [...room.players.values()].find((p) => p.seat === seat);
    if (!target) throw new RoomError('no_such_seat', '该座位不存在');
    if (!target.isAI) throw new RoomError('not_ai_seat', '只能移除 AI 座位');
    room.players.delete(target.id);
    // 清理被移除座位的选角，并按新座位号重建映射
    delete room.characterSelections[seat];
    const oldSel = { ...room.characterSelections };
    room.characterSelections = {};
    let i = 0;
    for (const p of room.players.values()) {
      const oldSeat = p.seat;
      p.seat = i;
      if (oldSel[oldSeat] !== undefined) room.characterSelections[i] = oldSel[oldSeat];
      i++;
    }
    this.broadcastRoom(room);
  }

  /** 玩家锁定角色选择（大厅期间，不可重复选同一角色） */
  lockCharacter(room: Room, player: Player, character: CharacterId): void {
    if (room.status !== 'lobby') throw new RoomError('already_started', '对局已开始');
    const others = Object.entries(room.characterSelections).filter(([s, c]) => c === character && Number(s) !== player.seat);
    if (others.length > 0) throw new RoomError('character_taken', `${character} 已被其他玩家选择`);
    room.characterSelections[player.seat] = character;
    this.broadcastRoom(room);
  }

  /** 主机随机打乱座位顺序（所有玩家包括 AI 一起参与洗牌） */
  shuffleSeats(room: Room, byPlayer: Player): void {
    if (room.hostPlayerId !== byPlayer.id) throw new RoomError('not_host', '仅主机可打乱座位');
    if (room.status !== 'lobby') throw new RoomError('already_started', '对局已开始');
    const players = [...room.players.values()];
    // 全部玩家（含 AI）一起 Fisher-Yates 洗牌
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j]!, players[i]!];
    }
    // 按洗牌结果重排座位号，选角数据跟随旧座位迁移
    const oldSel = { ...room.characterSelections };
    room.characterSelections = {};
    let i = 0;
    for (const p of players) {
      const oldSeat = p.seat;
      p.seat = i;
      if (oldSel[oldSeat] !== undefined) room.characterSelections[i] = oldSel[oldSeat];
      i++;
    }
    this.broadcastRoom(room);
  }

  /** 广播 AI 动作日志行（客户端按 l-ai 着色显示） */
  broadcastLog(room: Room, text: string): void {
    const msg = { op: 'log', text };
    for (const p of room.players.values()) if (p.connected) p.send(msg);
  }

  /** 主机开局：由落座人数导出配置（ADR-004 §3 座位→角色映射） */
  startGame(
    room: Room,
    byPlayer: Player,
    opts: { benchCharacter?: 'kaier' | 'baye'; seed?: number },
  ): void {
    if (room.hostPlayerId !== byPlayer.id) throw new RoomError('not_host', '仅主机可开局');
    if (room.status !== 'lobby') throw new RoomError('already_started', '对局已开始');
    const playerCount = room.players.size as PlayerCount;
    const characters = activeCharactersFor(playerCount, opts.benchCharacter);
    const activeSet = new Set(characters);
    const selections = room.characterSelections;
    const hasSelections = Object.keys(selections).length > 0;

    // 构建座位→角色映射
    const seatAssignments: Record<number, CharacterId[]> = {};
    if (playerCount === 1) {
      // 1P 模式：座0 控制全部角色，无视选角（单人无法拆分控制）
      seatAssignments[0] = [...characters];
    } else if (hasSelections) {
      // 有人选了角色：优先用选择，但需校验角色在当前激活池内（3P 弃角可能导致 AI 预选角色不在池中）
      const used = new Set<CharacterId>();
      // 第一轮：收集有效选择
      for (let seat = 0; seat < playerCount; seat++) {
        const sel = selections[seat];
        if (sel && activeSet.has(sel)) {
          seatAssignments[seat] = [sel];
          used.add(sel);
        }
      }
      // 第二轮：为缺失座位分配剩余角色
      const remaining = characters.filter((c) => !used.has(c));
      let remIdx = 0;
      for (let seat = 0; seat < playerCount; seat++) {
        if (!seatAssignments[seat]) {
          const ch = remaining[remIdx] ?? characters[seat]!;
          seatAssignments[seat] = [ch];
          remIdx++;
        }
      }
    } else {
      characters.forEach((cid, i) => {
        seatAssignments[i] = [cid];
      });
    }
    const config: GameConfig = {
      playerCount,
      seed: opts.seed ?? randomBytes(4).readUInt32BE(0),
      seatAssignments,
      ...(opts.benchCharacter ? { benchCharacter: opts.benchCharacter } : {}),
    };
    const { state } = beginGame(createInitialState(config));
    room.state = state;
    room.status = 'playing';
    this.broadcastRoom(room);
    this.broadcastViews(room);
  }

  /** 指令鉴权转发（control-manifest §7 零规则）：
   *  - resolve_decision：决策人座位（或 'all' 任意座位）
   *  - transfer_material：转出方控制座位（任意时机【L137】）
   *  - 其余：当前行动角色的控制座位 */
  handleCommand(room: Room, player: Player, cmd: Command): void {
    if (room.status !== 'playing' || !room.state) throw new RoomError('not_playing', '对局未在进行');
    const state = room.state;
    const controlled = state.config.seatAssignments[player.seat] ?? [];
    if (cmd.type === 'resolve_decision') {
      const d = state.pendingDecision;
      if (!d) throw new RoomError('no_such_decision', '当前无待决策事项');
      if (d.decider !== 'all' && !controlled.includes(d.decider as CharacterId)) {
        throw new RoomError('not_your_turn', '你不是该决策的决策人');
      }
    } else if (cmd.type === 'transfer_material') {
      if (!controlled.includes(cmd.character)) throw new RoomError('not_your_turn', '只能转出自己的材料');
    } else {
      const current = state.currentTurn?.character;
      if (!current || !controlled.includes(current)) {
        throw new RoomError('not_your_turn', '当前不是你控制角色的回合');
      }
    }
    const result = applyCommand(state, cmd);
    room.state = result.state;
    if (result.state.result) room.status = 'finished';
    this.broadcastViews(room, result.events);
  }

  snapshot(room: Room): RoomSnapshot {
    return {
      id: room.id,
      status: room.status,
      playerCount: room.status === 'lobby' ? null : ((room.state?.config.playerCount ?? null) as PlayerCount | null),
      players: [...room.players.values()].map((p) => ({
        playerId: p.id,
        seat: p.seat,
        name: p.name,
        connected: p.connected,
        host: p.id === room.hostPlayerId,
        ai: !!p.isAI,
        character: room.characterSelections[p.seat] ?? null,
      })),
      characterSelections: room.characterSelections,
    };
  }

  broadcastRoom(room: Room): void {
    const msg = { op: 'room', room: this.snapshot(room) };
    for (const p of room.players.values()) if (p.connected) p.send(msg);
  }

  /** 按座位投影 + 事件脱敏后个性化推送（control-manifest §8 唯一出口） */
  broadcastViews(room: Room, events: import('@elf-throne/engine').GameEvent[] = []): void {
    if (!room.state) return;
    room.seq += 1;
    for (const p of room.players.values()) {
      if (!p.connected) continue;
      p.send({
        op: 'view',
        seq: room.seq,
        view: projectView(room.state, p.seat),
        events: projectEvents(events, room.state, p.seat),
      });
    }
    // 状态变更的唯一汇聚点：驱动 AI 托管（自动应答决策 / 自动行动，微延迟分步）
    this.ai.poke(room);
  }

  /** EngineError 透传码；其余包一层 */
  errorOf(err: unknown): { code: string; message: string } {
    if (err instanceof EngineError) return { code: err.code, message: err.message };
    if (err instanceof RoomError) return { code: err.code, message: err.message };
    return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
  }

  private mustGet(roomId: string): Room {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) throw new RoomError('no_such_room', '房间不存在');
    return room;
  }

  private newRoomId(): string {
    for (;;) {
      let id = '';
      const bytes = randomBytes(4);
      for (let i = 0; i < 4; i++) id += ROOM_ALPHABET[(bytes[i] as number) % ROOM_ALPHABET.length];
      if (!this.rooms.has(id)) return id;
    }
  }

  private newPlayer(name: string, seat: number, send: (msg: unknown) => void): Player {
    return {
      id: randomBytes(8).toString('hex'),
      name: name.trim().slice(0, 24) || `玩家${seat + 1}`,
      token: randomBytes(16).toString('hex'),
      seat,
      connected: true,
      send,
    };
  }
}
