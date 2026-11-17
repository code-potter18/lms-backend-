CREATE TYPE "EmailDeliveryStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SENT',
    'FAILED',
    'UNKNOWN'
);

ALTER TABLE "patient_bio_data"
    ALTER COLUMN "patient_email" TYPE VARCHAR(255);

CREATE TABLE "patient_email_consent" (
    "id" BIGSERIAL NOT NULL,
    "patient_id" VARCHAR(100) NOT NULL,
    "email_address" VARCHAR(255) NOT NULL,
    "consented" BOOLEAN NOT NULL,
    "consented_by" VARCHAR(100) NOT NULL,
    "consented_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "patient_email_consent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_patient_email_consent_patient"
        FOREIGN KEY ("patient_id") REFERENCES "patient_bio_data"("patient_id")
        ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE TABLE "lab_report_email_delivery" (
    "id" VARCHAR(36) NOT NULL,
    "patient_id" VARCHAR(100) NOT NULL,
    "lab_report_id" VARCHAR(100) NOT NULL,
    "email_address" VARCHAR(255) NOT NULL,
    "message_id" VARCHAR(255),
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "error_message" VARCHAR(500),
    "sent_at" TIMESTAMP(6),
    "failed_at" TIMESTAMP(6),
    "created_by" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "lab_report_email_delivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_lab_report_email_delivery_patient"
        FOREIGN KEY ("patient_id") REFERENCES "patient_bio_data"("patient_id")
        ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "fk_lab_report_email_delivery_report"
        FOREIGN KEY ("lab_report_id") REFERENCES "lab_report"("lab_report_id")
        ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "uq_lab_report_email_delivery_active"
    ON "lab_report_email_delivery"("lab_report_id")
    WHERE "status" IN ('PENDING', 'PROCESSING', 'SENT', 'UNKNOWN');
CREATE INDEX "idx_patient_email_consent_patient_created"
    ON "patient_email_consent"("patient_id", "created_at" DESC);
CREATE INDEX "idx_lab_report_email_delivery_patient_created"
    ON "lab_report_email_delivery"("patient_id", "created_at" DESC);
CREATE INDEX "idx_lab_report_email_delivery_report_created"
    ON "lab_report_email_delivery"("lab_report_id", "created_at" DESC);
CREATE INDEX "idx_lab_report_email_delivery_status_created"
    ON "lab_report_email_delivery"("status", "created_at");
