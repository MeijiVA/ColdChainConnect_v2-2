ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "agent_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trucks" ADD CONSTRAINT "trucks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trucks_agent_id_idx" ON "trucks" ("agent_id");
