-- Patient In-App Notifications Migration
CREATE TABLE IF NOT EXISTS "patient_notification" (
    "id" BIGSERIAL NOT NULL,
    "notification_id" VARCHAR(100) NOT NULL,
    "patient_id" VARCHAR(100) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "message" TEXT NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "reference_id" VARCHAR(100),
    "event_key" VARCHAR(255) NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "patient_notification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_patient_notification_patient"
        FOREIGN KEY ("patient_id") REFERENCES "patient_bio_data"("patient_id")
        ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_patient_notification_id" ON "patient_notification"("notification_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_patient_notification_event_key" ON "patient_notification"("event_key");
CREATE INDEX IF NOT EXISTS "idx_patient_notification_patient_created" ON "patient_notification"("patient_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_patient_notification_patient_unread" ON "patient_notification"("patient_id", "is_read");
CREATE INDEX IF NOT EXISTS "idx_patient_notification_dedup" ON "patient_notification"("patient_id", "event_type", "reference_id");
