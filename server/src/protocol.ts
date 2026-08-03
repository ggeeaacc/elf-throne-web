/**
 * 客户端 ⇄ 服务端协议（ADR-002/004）。纯 JSON over WebSocket。
 */
import type { CharacterId, Command, GameView, GameEvent, PlayerCount } from '@elf-throne/engine';

// ── C → S ──
export type ClientMessage =
  | { op: 'create'; name: string }
  | { op: 'join'; roomId: string; name: string }
  | { op: 'rejoin'; roomId: string; token: string }
  | { op: 'start'; benchCharacter?: 'kaier' | 'baye'; seed?: number }
  | { op: 'add_ai' }
  | { op: 'remove_ai'; seat: number }
  | { op: 'cmd'; cmd: Command }
  | { op: 'lock_character'; character: CharacterId }
  | { op: 'shuffle_seats' }
  | { op: 'ping' };

// ── S → C ──
export interface PlayerSnapshot {
  playerId: string;
  seat: number;
  name: string;
  connected: boolean;
  host: boolean;
  /** AI 托管座位标记 */
  ai: boolean;
  /** 已锁定角色 */
  character: CharacterId | null;
}

export interface RoomSnapshot {
  id: string;
  status: 'lobby' | 'playing' | 'finished';
  playerCount: PlayerCount | null;
  players: PlayerSnapshot[];
  /** 座位→角色映射（仅 lobby 期间从 selections 构建） */
  characterSelections: Record<number, CharacterId>;
}

export type ServerMessage =
  | { op: 'hello'; playerId: string; token: string; seat: number; roomId: string }
  | { op: 'room'; room: RoomSnapshot }
  | { op: 'view'; seq: number; view: GameView; events: GameEvent[] }
  | { op: 'log'; text: string }
  | { op: 'error'; code: string; message: string }
  | { op: 'pong' };
