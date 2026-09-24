import { useQuery } from '@tanstack/react-query';
import type { Building, Invitation, Member, PlanUsage } from '@roomly/shared';
import { api } from './api';

export const keys = {
  spaces: ['spaces'] as const,
  planUsage: ['plan-usage'] as const,
  members: ['members'] as const,
  invitations: ['invitations'] as const,
};

export const useSpaces = () => useQuery({ queryKey: keys.spaces, queryFn: () => api.get<Building[]>('/spaces') });
export const usePlanUsage = () => useQuery({ queryKey: keys.planUsage, queryFn: () => api.get<PlanUsage>('/plan-usage') });
export const useMembers = () => useQuery({ queryKey: keys.members, queryFn: () => api.get<Member[]>('/members') });
export const useInvitations = () => useQuery({ queryKey: keys.invitations, queryFn: () => api.get<Invitation[]>('/invitations') });
