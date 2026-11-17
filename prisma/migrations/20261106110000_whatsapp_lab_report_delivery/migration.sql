CREATE TYPE "WhatsappDeliveryStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SENT',
    'DELIVERED',
    'READ',
    'FAILED'
);

CREATE TABLE "whatsapp_patient_consent" (
    "id" BIGSERIAL NOT NULL,
    "patient_id" VARCHAR(100) NOT NULL,
    "consented" BOOLEAN NOT NULL,
    "consented_by" VARCHAR(100) NOT NULL,
    "consented_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_patient_consent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_delivery" (
    "id" VARCHAR(30) NOT NULL,
    "patient_id" VARCHAR(100) NOT NULL,
    "lab_report_id" VARCHAR(100) NOT NULL,
    "phone_number" VARCHAR(16) NOT NULL,
    "whatsapp_message_id" VARCHAR(100),
    "media_id" VARCHAR(100),
    "status" "WhatsappDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "error_message" VARCHAR(500),
    "sent_at" TIMESTAMP(6),
    "delivered_at" TIMESTAMP(6),
    "read_at" TIMESTAMP(6),
    "failed_at" TIMESTAMP(6),
    "created_by" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "whatsapp_delivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_whatsapp_delivery_message"
    ON "whatsapp_delivery"("whatsapp_message_id");
CREATE UNIQUE INDEX "uq_whatsapp_delivery_active_report_phone"
    ON "whatsapp_delivery"("lab_report_id", "phone_number")
    WHERE "status" IN ('PENDING', 'PROCESSING', 'SENT', 'DELIVERED', 'READ');
CREATE INDEX "idx_whatsapp_consent_patient_created"
    ON "whatsapp_patient_consent"("patient_id", "created_at" DESC);
CREATE INDEX "idx_whatsapp_delivery_patient_created"
    ON "whatsapp_delivery"("patient_id", "created_at" DESC);
CREATE INDEX "idx_whatsapp_delivery_report_created"
    ON "whatsapp_delivery"("lab_report_id", "created_at" DESC);
CREATE INDEX "idx_whatsapp_delivery_status_created"
    ON "whatsapp_delivery"("status", "created_at");

ALTER TABLE "whatsapp_patient_consent"
    ADD CONSTRAINT "fk_whatsapp_consent_patient"
    FOREIGN KEY ("patient_id") REFERENCES "patient_bio_data"("patient_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "whatsapp_delivery"
    ADD CONSTRAINT "fk_whatsapp_delivery_report"
    FOREIGN KEY ("lab_report_id") REFERENCES "lab_report"("lab_report_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "whatsapp_delivery"
    ADD CONSTRAINT "fk_whatsapp_delivery_patient"
    FOREIGN KEY ("patient_id") REFERENCES "patient_bio_data"("patient_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
