import { z } from 'zod';
import { personNameSchema, roleSchema } from './auth.js';

export const AMENITIES = ['tv', 'video', 'whiteboard', 'projector', 'phone'] as const;
export type Amenity = (typeof AMENITIES)[number];
export const AMENITY_LABELS: Record<Amenity, string> = {
  tv: 'TV screen',
  video: 'Video conferencing',
  whiteboard: 'Whiteboard',
  projector: 'Projector',
  phone: 'Conference phone',
};

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.includes('/') || tz === 'UTC'; // IANA names only, not abbreviations like "EST"
  } catch {
    return false;
  }
}

const name = z.string().trim().min(1).max(120);

export const buildingInputSchema = z.object({
  name,
  address: z.string().trim().max(300).nullish().transform((v) => v || null),
  timezone: z.string().refine(isValidTimeZone, 'Must be an IANA time zone such as Asia/Kolkata'),
});
export type BuildingInput = z.infer<typeof buildingInputSchema>;

export const floorInputSchema = z.object({
  name,
  level: z.number().int().min(-10).max(200),
});
export type FloorInput = z.infer<typeof floorInputSchema>;

export const roomInputSchema = z.object({
  name,
  capacity: z.number().int().min(1).max(500),
  amenities: z.array(z.enum(AMENITIES)).max(AMENITIES.length).default([]).transform((a) => [...new Set(a)]),
});
export type RoomInput = z.infer<typeof roomInputSchema>;

export const roomUpdateSchema = roomInputSchema.partial().extend({ isActive: z.boolean().optional() });
export type RoomUpdate = z.infer<typeof roomUpdateSchema>;

export interface Room {
  id: string;
  floorId: string;
  name: string;
  capacity: number;
  amenities: Amenity[];
  isActive: boolean;
}

export interface Floor {
  id: string;
  buildingId: string;
  name: string;
  level: number;
  rooms: Room[];
}

export interface Building {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  floors: Floor[];
}

export interface PlanUsage {
  planId: string;
  planName: string;
  roomLimit: number | null;
  activeRooms: number;
}

// -----------------------------------------------------------------------------
// Team
// -----------------------------------------------------------------------------

export interface Member {
  id: string;
  email: string;
  name: string;
  role: z.infer<typeof roleSchema>;
  isActive: boolean;
  createdAt: string;
}

export const memberUpdateSchema = z.object({
  name: personNameSchema.optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
});
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;
