/**
 * Kysely table types, written by hand to mirror db/migrations. Keep in sync.
 * Generated<T> marks columns with a database default.
 */
import type { ColumnType, Generated } from 'kysely';

export type UserRole = 'admin' | 'employee';
export type BookingStatus = 'confirmed' | 'cancelled';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type CreatedAt = ColumnType<Date, never, never>;

export interface PlansTable {
  id: string;
  name: string;
  room_limit: number | null;
  monthly_price_cents: number;
  sort_order: number;
}

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  plan_id: Generated<string>;
  stripe_customer_id: string | null;
  created_at: CreatedAt;
}

export interface SubscriptionsTable {
  org_id: string;
  stripe_subscription_id: string;
  plan_id: string;
  status: string;
  current_period_end: Timestamp | null;
  cancel_at_period_end: Generated<boolean>;
  updated_at: Generated<Timestamp>;
}

export interface UsersTable {
  id: Generated<string>;
  org_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Generated<UserRole>;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
}

export interface InvitationsTable {
  id: Generated<string>;
  org_id: string;
  email: string;
  role: Generated<UserRole>;
  token_hash: string;
  invited_by: string;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  replaced_by: string | null;
  created_at: CreatedAt;
}

export interface BuildingsTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  address: string | null;
  timezone: string;
  created_at: CreatedAt;
}

export interface FloorsTable {
  id: Generated<string>;
  org_id: string;
  building_id: string;
  name: string;
  level: number;
  created_at: CreatedAt;
}

export interface RoomsTable {
  id: Generated<string>;
  org_id: string;
  floor_id: string;
  name: string;
  capacity: number;
  amenities: Generated<string[]>;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
}

export interface BookingsTable {
  id: Generated<string>;
  org_id: string;
  room_id: string;
  user_id: string;
  title: string;
  /** tstzrange, e.g. '["2030-01-01 10:00:00+00","2030-01-01 11:00:00+00")'. Read via lower()/upper(). */
  during: string;
  status: Generated<BookingStatus>;
  created_at: CreatedAt;
  updated_at: Generated<Timestamp>;
  cancelled_at: Timestamp | null;
}

export interface Database {
  plans: PlansTable;
  organizations: OrganizationsTable;
  subscriptions: SubscriptionsTable;
  users: UsersTable;
  invitations: InvitationsTable;
  refresh_tokens: RefreshTokensTable;
  buildings: BuildingsTable;
  floors: FloorsTable;
  rooms: RoomsTable;
  bookings: BookingsTable;
}
