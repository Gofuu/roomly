import { useQuery } from '@tanstack/react-query';
import type { Building, BuildingSchedule, Invitation, Member, MyBooking, PlanUsage, RoomSchedule } from '@roomly/shared';
import { api } from './api';

export const keys = {
  spaces: ['spaces'] as const,
  planUsage: ['plan-usage'] as const,
  members: ['members'] as const,
  invitations: ['invitations'] as const,
  /** Prefix for every schedule/booking view, so one invalidation refreshes them all. */
  bookings: ['bookings'] as const,
  buildingSchedule: (buildingId: string, date: string) => ['bookings', 'building', buildingId, date] as const,
  roomBookings: (roomId: string, from: string, to: string) => ['bookings', 'room', roomId, from, to] as const,
  myBookings: (when: 'upcoming' | 'past') => ['bookings', 'mine', when] as const,
};

export const useSpaces = () => useQuery({ queryKey: keys.spaces, queryFn: () => api.get<Building[]>('/spaces') });
export const usePlanUsage = () => useQuery({ queryKey: keys.planUsage, queryFn: () => api.get<PlanUsage>('/plan-usage') });
export const useMembers = () => useQuery({ queryKey: keys.members, queryFn: () => api.get<Member[]>('/members') });
export const useInvitations = () => useQuery({ queryKey: keys.invitations, queryFn: () => api.get<Invitation[]>('/invitations') });

export const useBuildingSchedule = (buildingId: string | undefined, date: string) =>
  useQuery({
    queryKey: keys.buildingSchedule(buildingId ?? '', date),
    queryFn: () => api.get<BuildingSchedule>(`/buildings/${buildingId}/schedule?date=${date}`),
    enabled: !!buildingId,
    placeholderData: (prev) => prev, // keep the old day on screen while the next one loads
  });

export const useRoomBookings = (roomId: string, from: string, to: string) =>
  useQuery({
    queryKey: keys.roomBookings(roomId, from, to),
    queryFn: () => api.get<RoomSchedule>(`/rooms/${roomId}/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    enabled: !!from,
    placeholderData: (prev) => prev,
  });

export const useMyBookings = (when: 'upcoming' | 'past') =>
  useQuery({ queryKey: keys.myBookings(when), queryFn: () => api.get<MyBooking[]>(`/bookings/mine?when=${when}`) });
