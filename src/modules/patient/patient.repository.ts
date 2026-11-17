import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma";
import { GetPatientsQuery, PatientContactDuplicate } from "./patient.types";

export class PatientRepository {

    async findUsername(username: string) {

        return prisma.user_table.findFirst({
            where: {
                username
            }
        });

    }

    async findMobile(mobile: string) {

        return prisma.patient_bio_data.findFirst({
            where: {
                patient_primary_mobile: mobile
            }
        });

    }

    async findEmail(email: string) {

        return prisma.patient_bio_data.findFirst({
            where: {
                patient_email: {
                    equals: email.trim(),
                    mode: "insensitive"
                }
            }
        });

    }

    async findContactDuplicates(
        phoneVariants: string[],
        email: string,
        branchId?: string
    ): Promise<PatientContactDuplicate[]> {
        if (phoneVariants.length === 0 && !email) {
            return [];
        }

        const primaryPhoneMatch = phoneVariants.length > 0
            ? Prisma.sql`regexp_replace(COALESCE("patient_primary_mobile", ''), '[^0-9]', '', 'g') IN (${Prisma.join(phoneVariants)})`
            : Prisma.sql`FALSE`;
        const mobileMatch = primaryPhoneMatch;
        const emailMatch = email
            ? Prisma.sql`LOWER(BTRIM(COALESCE("patient_email", ''))) = ${email}`
            : Prisma.sql`FALSE`;
        const branchFilter = branchId
            ? Prisma.sql`AND "branch_id" = ${branchId}`
            : Prisma.empty;

        return prisma.$queryRaw<PatientContactDuplicate[]>(Prisma.sql`
            SELECT
                "patient_id",
                "patient_first_name",
                "patient_middle_name",
                "patient_last_name",
                "patient_primary_mobile",
                "patient_email",
                ${mobileMatch} AS "matched_by_mobile",
                ${emailMatch} AS "matched_by_email"
            FROM "patient_bio_data"
            WHERE (${mobileMatch} OR ${emailMatch})
            ${branchFilter}
            ORDER BY "id" DESC
        `);
    }

    async findBranch(branchId: string) {

        return prisma.branch.findUnique({
            where: {
                branch_id: branchId
            }
        });

    }

    async getPatients(query: GetPatientsQuery) {

        const {
            branchId,
            patientType,
            status,
            search,
            dateFrom,
            dateTo,
            page = 1,
            limit = 100
        } = query;

        const where: Prisma.patient_bio_dataWhereInput = {};

        if (branchId) {
            where.branch_id = branchId;
        }

        if (patientType) {
            where.patient_type = patientType;
        }

        if (status) {
            where.patient_active = status;
        }

        if (dateFrom || dateTo) {
            where.user_table = {
                created_at: {
                    ...(dateFrom && { gte: new Date(dateFrom) }),
                    ...(dateTo && { lte: new Date(dateTo + "T23:59:59.999Z") })
                }
            };
        }

        if (search) {

            where.OR = [

                {
                    patient_first_name: {
                        contains: search,
                        mode: "insensitive"
                    }
                },

                {
                    patient_last_name: {
                        contains: search,
                        mode: "insensitive"
                    }
                },

                {
                    patient_email: {
                        contains: search,
                        mode: "insensitive"
                    }
                },

                {
                    patient_primary_mobile: {
                        contains: search,
                        mode: "insensitive"
                    }
                },

                {
                    patient_id: {
                        contains: search,
                        mode: "insensitive"
                    }
                }

            ];

        }

        const patients = await prisma.patient_bio_data.findMany({

            where,

            include: {

                branch: {
                    select: {
                        branch_name: true
                    }
                },

                user_table: {
                    select: {
                        role_type: true,
                        user_status: true
                    }
                }

            },

            skip: (page - 1) * limit,

            take: limit,

            orderBy: {
                id: "desc"
            }

        });

        const total = await prisma.patient_bio_data.count({
            where
        });

        return {

            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            patients

        };

    }

    async getPatientById(patientId: string) {

        return prisma.patient_bio_data.findUnique({

            where: {
                patient_id: patientId
            },

            include: {
                branch: {
                    select: {
                        branch_id: true,
                        branch_name: true,
                        branch_area: true,
                        branch_code: true,
                        branch_status: true,
                    }
                },
                user_table: {
                    select: {
                        user_id: true,
                        username: true,
                        role_type: true,
                        user_status: true,
                        created_at: true,
                    }
                }
            }

        });

    }

    async updatePatient(
        patientId: string,
        data: Prisma.patient_bio_dataUpdateInput
    ) {

        return prisma.patient_bio_data.update({

            where: {
                patient_id: patientId
            },

            data

        });

    }

}
