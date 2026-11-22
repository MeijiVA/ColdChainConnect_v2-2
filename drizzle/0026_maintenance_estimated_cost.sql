ALTER TABLE "maintenance_requests" ADD COLUMN IF NOT EXISTS "estimated_cost" numeric(12, 2);
