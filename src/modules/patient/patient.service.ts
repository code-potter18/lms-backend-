import bcrypt from "bcrypt";
import crypto, { randomInt } from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma";
import { PatientRepository } from "./patient.repository";
import {
    CreatePatientRequest,
    UpdatePatientRequest,
    GetPatientsQuery,
    PatientContactDuplicate
} from "./patient.types";
import { CreatePatientHistoryDTO } from "./patient-history.types";
import { generateId } from "../../utils/idGenerator";
import { phoneMatchVariants } from "./patient-contact.utils";
import { hashPassword } from "../../utils/bcrypt";
import { sendPatientActivationEmail } from "../../utils/mail";

const repository = new PatientRepository();

export class PatientService {

    async findContactDuplicates(
        mobile: string,
        email?: string,
        branchId?: string
    ): Promise<PatientContactDuplicate[]> {
        return repository.findContactDuplicates(
            phoneMatchVariants(mobile),
            email?.trim().toLowerCase() ?? "",
            branchId
        );
    }

    async createPatient(data: CreatePatientRequest, createdBy: string) {

        const contactDuplicates = await this.findContactDuplicates(data.mobile, data.email);
        if (contactDuplicates.some((match) => match.matched_by_mobile)) {
            throw new Error("Mobile already exists");
        }
        if (contactDuplicates.some((match) => match.matched_by_email)) {
            throw new Error("Email already exists");
        }

        const branch = await repository.findBranch(data.branch_id);

        if (!branch) {
            throw new Error("Branch not found");
        }

        // Generate a unique portal username based on the patient's First Name
        let finalUsername: string;
        const isLabWalkIn = data.registration_source === "LAB_WALK_IN";
        const hasExplicitCustomUsername =
            data.username &&
            !isLabWalkIn &&
            !data.username.startsWith("walkin_") &&
            !/^PAT\d+$/i.test(data.username.trim());

        if (hasExplicitCustomUsername) {
            const trimmed = data.username!.trim().toLowerCase();
            const existing = await repository.findUsername(trimmed);
            if (existing) {
                throw new Error("Username already exists");
            }
            finalUsername = trimmed;
        } else {
            const cleanFirst = (data.first_name || "")
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "");

            const baseUsername = cleanFirst || "patient";
            let candidate = baseUsername;
            let counter = 2;
            while (await repository.findUsername(candidate)) {
                candidate = `${baseUsername}${counter}`;
                counter++;
            }
            finalUsername = candidate;
        }

        const hashedPassword = data.password
            ? await hashPassword(data.password)
            : await hashPassword(crypto.randomUUID());

        const result = await prisma.$transaction(async (tx) => {

            const patientId = await generateId(tx, "PATIENT");
            const userId = await generateId(tx, "USER");

            const user = await tx.user_table.create({

                data: {

                    user_id: userId,

                    username: finalUsername,

                    password: hashedPassword,

                    role_type: "PATIENT",

                    created_by: createdBy,

                    branch_id: data.branch_id,

                    user_status: 2 // PENDING_ACTIVATION

                }

            });

            const patient = await tx.patient_bio_data.create({

                data: {

                    patient_id: patientId,

                    user_id: user.user_id,

                    branch_id: data.branch_id,

                    patient_first_name: data.first_name,

                    patient_middle_name: data.middle_name,

                    patient_last_name: data.last_name,

                    patient_gender: data.gender,

                    patient_dob: data.dob
                        ? new Date(data.dob)
                        : undefined,

                    patient_age: data.age,

                    patient_blood_group: data.blood_group,

                    patient_primary_mobile: data.mobile,

                    patient_alternate_mobile: data.alternate_mobile,

                    patient_email: data.email,

                    patient_marital_status: data.marital_status,

                    patient_nationality: data.nationality,

                    patient_photo_url: data.photo,

                    patient_type: data.patient_type,

                    patient_active: "Active",
                    patient_state:data.patient_state,
                    patient_district:data.patient_district,
                    patient_area:data.patient_area,
                    patient_pincode:data.patient_pincode,
                    Patient_address: data.current_address,
                    Patient_Emergency_contact_name: data.emergency_name,
                    Emergency_contact_relation: data.emergency_relation,
                    Patient_emergency_mobile: data.emergency_mobile,

                    referral_type: data.patient_type === "Referral"
                        ? (data.referral_type?.trim() || null)
                        : null,
                    referred_by: data.patient_type === "Referral"
                        ? (data.referred_by?.trim() || null)
                        : null,
                    referral_contact: data.patient_type === "Referral"
                        ? (data.referral_contact?.trim() || null)
                        : null,
                    referral_notes: data.patient_type === "Referral"
                        ? (data.referral_notes?.trim() || null)
                        : null,
                    referral_address: data.patient_type === "Referral"
                        ? (data.referral_address?.trim() || null)
                        : null,
                    referral_mail: data.patient_type === "Referral"
                        ? (data.referral_mail?.trim() || null)
                        : null,
                    referral_branch_name: data.patient_type === "Referral"
                        ? (data.referral_branch_name?.trim() || null)
                        : null

                }

            });


            // Create single-use activation token expiring in 24 hours
            const activationToken = randomInt(100000, 999999).toString();
            const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const otpId = await generateId(tx, "LOGIN_OTP");
            await tx.login_otp.create({
                data: {
                    otp_id: otpId,
                    user_id: userId,
                    user_type: "PATIENT_ACTIVATION",
                    otp_code: activationToken,
                    expires_at: expiry,
                    is_verified: false,
                }
            });

            return {
                patient: {
                    patient_id: patient.patient_id,
                    patient_first_name: patient.patient_first_name,
                    patient_middle_name: patient.patient_middle_name,
                    patient_last_name: patient.patient_last_name
                },
                user: {
                    user_id: user.user_id,
                    username: user.username,
                    user_status: "PENDING_ACTIVATION"
                },
                activationToken,
                patientEmail: data.email,
                patientFullName: [data.first_name, data.last_name].filter(Boolean).join(" ")
            };

        });

        // Send activation email with the secure activation link and token
        if (result.patientEmail) {
            await sendPatientActivationEmail(
                result.patientEmail,
                result.patientFullName,
                result.activationToken,
                result.patient.patient_id,
                result.user.username,
                false
            ).catch((err: any) => {
                console.warn("Could not send patient activation email:", err.message);
            });
        }

        return {
            patient: result.patient,
            user: result.user
        };

    }

    async getPatients(query: GetPatientsQuery) {

        return repository.getPatients(query);

    }

    async getPatientById(patientId: string) {

        const patient = await repository.getPatientById(patientId);

        if (!patient) {
            throw new Error("Patient not found");
        }

        return {
            ...patient,
            current_address: patient.Patient_address ?? null,
            emergency_name: patient.Patient_Emergency_contact_name ?? null,
            emergency_relation: patient.Emergency_contact_relation ?? null,
            emergency_mobile: patient.Patient_emergency_mobile ?? null
        };

    }

    async updatePatient(
        patientId: string,
        data: UpdatePatientRequest
    ) {

        const existing = await repository.getPatientById(patientId);

        if (!existing) {
            throw new Error("Patient not found");
        }

        const requestedEmail = data.email?.trim();
        const existingEmail = existing.patient_email?.trim();
        if (existingEmail && requestedEmail !== undefined && requestedEmail.toLowerCase() !== existingEmail.toLowerCase()) {
            throw new Error("An existing patient email cannot be overwritten.");
        }

        if (requestedEmail && requestedEmail.toLowerCase() !== existingEmail?.toLowerCase()) {

            const email = await repository.findEmail(requestedEmail);

            if (email) {
                throw new Error("Email already exists");
            }

        }

        if (
            data.mobile &&
            data.mobile !== existing.patient_primary_mobile
        ) {

            const mobile = await repository.findMobile(data.mobile);

            if (mobile) {
                throw new Error("Mobile already exists");
            }

        }

        if (data.branch_id) {

            const branch = await repository.findBranch(data.branch_id);

            if (!branch) {
                throw new Error("Branch not found");
            }

        }

        return repository.updatePatient(patientId, {

            patient_first_name: data.first_name,

            patient_middle_name: data.middle_name,

            patient_last_name: data.last_name,

            patient_gender: data.gender,

            patient_dob: data.dob
                ? new Date(data.dob)
                : undefined,

            patient_age: data.age,

            patient_blood_group: data.blood_group,

            patient_primary_mobile: data.mobile,

            patient_alternate_mobile: data.alternate_mobile,

            patient_email: data.email,

            patient_marital_status: data.marital_status,

            patient_nationality: data.nationality,

            patient_photo_url: data.photo,

            patient_type: data.patient_type,

            patient_active: data.patient_active,
            patient_state:data.patient_state,
            patient_district:data.patient_district,
            patient_area:data.patient_area,
            patient_pincode:data.patient_pincode,
            Patient_address: data.current_address,
            Patient_Emergency_contact_name: data.emergency_name,
            Emergency_contact_relation: data.emergency_relation,
            Patient_emergency_mobile: data.emergency_mobile,

            // Referral details — force NULL (clear/delete from DB) whenever patient_type is
            // not "Referral", so stale referral data never survives an edit.
            ...(data.patient_type !== undefined
                ? {
                    referral_type: data.patient_type === "Referral"
                        ? (data.referral_type?.trim() || null)
                        : null,
                    referred_by: data.patient_type === "Referral"
                        ? (data.referred_by?.trim() || null)
                        : null,
                    referral_contact: data.patient_type === "Referral"
                        ? (data.referral_contact?.trim() || null)
                        : null,
                    referral_notes: data.patient_type === "Referral"
                        ? (data.referral_notes?.trim() || null)
                        : null,
                    referral_address: data.patient_type === "Referral"
                        ? (data.referral_address?.trim() || null)
                        : null,
                    referral_mail: data.patient_type === "Referral"
                        ? (data.referral_mail?.trim() || null)
                        : null,
                    referral_branch_name: data.patient_type === "Referral"
                        ? (data.referral_branch_name?.trim() || null)
                        : null,
                }
                : {
                    ...(data.referral_type !== undefined ? { referral_type: data.referral_type?.trim() || null } : {}),
                    ...(data.referred_by !== undefined ? { referred_by: data.referred_by?.trim() || null } : {}),
                    ...(data.referral_contact !== undefined ? { referral_contact: data.referral_contact?.trim() || null } : {}),
                    ...(data.referral_notes !== undefined ? { referral_notes: data.referral_notes?.trim() || null } : {}),
                    ...(data.referral_address !== undefined ? { referral_address: data.referral_address?.trim() || null } : {}),
                    ...(data.referral_mail !== undefined ? { referral_mail: data.referral_mail?.trim() || null } : {}),
                    ...(data.referral_branch_name !== undefined ? { referral_branch_name: data.referral_branch_name?.trim() || null } : {}),
                }),

            branch: data.branch_id
                ? {
                    connect: {
                        branch_id: data.branch_id
                    }
                }
                : undefined

        });

    }

    async updatePatientEmail(patientId: string, emailAddress: string, actorId: string) {
        const existing = await repository.getPatientById(patientId);
        if (!existing) {
            throw new Error("Patient not found");
        }
        if (!actorId || actorId.length > 100) {
            throw new Error("The authenticated user cannot be recorded for email consent.");
        }

        const email = emailAddress.trim();

        /* Lab staff may correct the registered email from Report Transfer, so an
           already-set address on the SAME patient can be replaced. The update is
           always an UPDATE of the existing patient row - never a second patient. */
        const duplicate = await repository.findEmail(email);
        if (duplicate && duplicate.patient_id !== patientId) {
            throw new Error("Email already exists");
        }

        if (existing.patient_email?.trim().toLowerCase() === email.toLowerCase()) {
            return existing;
        }

        /* Saving a corrected destination invalidates any prior consent for that
           address. A fresh Report Transfer attestation is required before send. */
        return prisma.$transaction(async (transaction) => {
            const patient = await transaction.patient_bio_data.update({
                where: { patient_id: patientId },
                data: { patient_email: email },
            });
            await transaction.patient_email_consent.create({
                data: {
                    patient_id: patientId,
                    email_address: email,
                    consented: false,
                    consented_by: actorId,
                },
            });
            return patient;
        });
    }

    async createPatientHistory(data: CreatePatientHistoryDTO, createdBy: string) {
        const hasAnyVital =
            data.systolicBp !== undefined ||
            data.diastolicBp !== undefined ||
            data.pulse !== undefined ||
            data.respiratoryRate !== undefined ||
            data.temperature !== undefined ||
            data.oxygenSaturation !== undefined ||
            (data.bloodSugar !== undefined && data.bloodSugar !== "") ||
            data.weight !== undefined ||
            data.height !== undefined ||
            data.severity !== undefined ||
            data.painScore !== undefined ||
            (data.clinicalNotes !== undefined && data.clinicalNotes !== "");

        if (!hasAnyVital) {
            throw new Error("At least one vital value is required to record vitals.");
        }

        let branchId = data.branchId;
        let departmentId = data.departmentId;
        let employeeId = data.employeeId;
        let appointmentStatus: string | null = null;

        if (data.appointmentId) {
            const appointment = await prisma.appointment_history.findUnique({
                where: { appointment_id: data.appointmentId },
                select: {
                    branch_id: true,
                    department_id: true,
                    employee_id: true,
                    status: true,
                }
            });
            appointmentStatus = appointment?.status ?? null;

            if (appointment) {
                branchId ??= appointment.branch_id ?? undefined;
                departmentId ??= appointment.department_id ?? undefined;
                employeeId ??= appointment.employee_id ?? undefined;
            }
        }

        // If still no branch, use createdBy's branch
        if (!branchId) {
            const user = await prisma.user_table.findUnique({
                where: { user_id: createdBy },
                select: { branch_id: true }
            });
            branchId ??= user?.branch_id ?? undefined;
        }

        if (!branchId) {
            throw new Error("Branch not found for the current user. Unable to record vitals.");
        }

        let computedBmi: number | null = null;
        if (data.height && data.weight) {
            computedBmi = Math.round((data.weight / Math.pow(data.height / 100, 2)) * 10) / 10;
        }

        const bloodSugarRaw = data.bloodSugar !== undefined && data.bloodSugar !== null && String(data.bloodSugar).trim() !== ""
            ? Number(data.bloodSugar)
            : NaN;
        const bloodSugarValue = Number.isFinite(bloodSugarRaw) ? bloodSugarRaw : null;

        const painRaw = data.severity ?? data.painScore;
        const painScoreValue = painRaw === undefined || painRaw === null ? null : BigInt(painRaw);

        return prisma.$transaction(async (tx) => {
            let encounter = data.appointmentId
                ? await tx.encounter.findUnique({ where: { appointment_id: data.appointmentId } })
                : null;

            if (!encounter) {
                const encounterNo = await generateId(tx, "ENCOUNTER");
                encounter = await tx.encounter.create({
                    data: {
                        encounter_no: encounterNo,
                        branch_id: branchId!,
                        patient_id: data.patientId,
                        appointment_id: data.appointmentId,
                        department_id: departmentId,
                        employee_id: employeeId,
                        user_id: createdBy,
                    }
                });

                /* Vitals are taken with the patient present: the visit has
                   started, so a still-booked appointment is checked in (the
                   doctor's check-in then moves it into consultation). */
                if (data.appointmentId && (appointmentStatus === "SCHEDULED" || appointmentStatus === "RESCHEDULED")) {
                    await tx.appointment_history.update({
                        where: { appointment_id: data.appointmentId },
                        data: { status: "CHECKED_IN" }
                    });
                }
            }

            // Per-field fill: only write fields that are still empty on the encounter
            const updateData: Prisma.encounterUncheckedUpdateInput = {};
            const fillIfEmpty = (key: string, existing: unknown, incoming: unknown) => {
                if (incoming !== undefined && incoming !== null && (existing === null || existing === undefined)) {
                    (updateData as Record<string, unknown>)[key] = incoming;
                }
            };

            fillIfEmpty("systolic_bp", encounter.systolic_bp, data.systolicBp);
            fillIfEmpty("diastolic_bp", encounter.diastolic_bp, data.diastolicBp);
            fillIfEmpty("pulse", encounter.pulse, data.pulse);
            fillIfEmpty("respiratory_rate", encounter.respiratory_rate, data.respiratoryRate);
            fillIfEmpty("spo2", encounter.spo2, data.oxygenSaturation);
            fillIfEmpty("temperature", encounter.temperature, data.temperature);
            fillIfEmpty("weight", encounter.weight, data.weight);
            fillIfEmpty("height", encounter.height, data.height);
            fillIfEmpty("BMI", encounter.BMI, computedBmi);
            fillIfEmpty("blood_sugar", encounter.blood_sugar, bloodSugarValue);
            fillIfEmpty("pain_score", encounter.pain_score, painScoreValue);
            fillIfEmpty("clinical_notes", encounter.clinical_notes, data.clinicalNotes);

            if (Object.keys(updateData).length > 0) {
                encounter = await tx.encounter.update({
                    where: { encounter_no: encounter.encounter_no },
                    data: updateData
                });
            }

            return {
                patientHistoryId: encounter.encounter_no,
                patientId: encounter.patient_id,
                appointmentId: encounter.appointment_id,
                visitDate: encounter.encounter_ts.toISOString(),
                systolicBp: encounter.systolic_bp,
                diastolicBp: encounter.diastolic_bp,
                pulse: encounter.pulse,
                respiratoryRate: encounter.respiratory_rate,
                temperature: encounter.temperature === null ? null : Number(encounter.temperature),
                oxygenSaturation: encounter.spo2,
                bloodSugar: encounter.blood_sugar === null ? null : encounter.blood_sugar.toString(),
                weight: encounter.weight === null ? null : Number(encounter.weight),
                height: encounter.height === null ? null : Number(encounter.height),
                bmi: encounter.BMI === null ? null : Number(encounter.BMI),
                painScore: encounter.pain_score === null ? null : Number(encounter.pain_score),
                severity: encounter.pain_score === null ? null : Number(encounter.pain_score),
                visitType: encounter.encounter_type,
                visitStatus: encounter.status,
                clinicalNotes: encounter.clinical_notes,
            };
        });
    }

}
