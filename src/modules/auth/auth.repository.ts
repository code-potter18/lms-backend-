import prisma from "../../config/prisma";

export class AuthRepository {

  async findUserById(userId: string) {
    return prisma.user_table.findFirst({
      where: { user_id: userId },
    });
  }

  async findUserByUsername(username: string) {
    const trimmed = (username || "").trim();
    return prisma.user_table.findFirst({
      where: {
        OR: [
          {
            username: {
              equals: trimmed,
              mode: "insensitive",
            },
          },
          {
            patient_bio_data: {
              some: {
                OR: [
                  {
                    patient_id: {
                      equals: trimmed,
                      mode: "insensitive",
                    },
                  },
                  {
                    patient_email: {
                      equals: trimmed,
                      mode: "insensitive",
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      include: {
        branch: true,
        employees: {
          include: {
            branch: true,
          },
        },
        patient_bio_data: {
          include: {
            branch: true,
          },
        },
        user_branch_mapping: {
          where: { status: 1 },
          include: {
            branch: true,
          },
        },
      },
    });
  }

  async updateKpiPreferences(userId: string, kpiPreferences: string | null) {
    return prisma.user_table.update({
      where: { user_id: userId },
      data: { kpi_preferences: kpiPreferences },
    });
  }

  async updateKpiUsage(userId: string, kpiUsage: string | null) {
    return prisma.user_table.update({
      where: { user_id: userId },
      data: { kpi_usage: kpiUsage },
    });
  }

}