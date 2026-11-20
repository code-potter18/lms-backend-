import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma";
import { CreateLabReportDto, UpdateLabReportDto, TransferLabReportDto } from "./lab-report.types";

export class LabReportRepository {
  async findTransferQueue(branchId?: string) {
    const reports = await prisma.lab_report.findMany({
      where: {
        approved_by: { not: null },
        approved_datetime: { not: null },
        report_file: { not: null },
        report_status: { in: ["Approved", "Generated", "Delivered", "Sent"] },
        ...(branchId ? { lab_order: { branch_id: branchId } } : {}),
      },
      orderBy: { approved_datetime: "desc" },
      include: {
        employees: { select: { employee_id: true, first_name: true, last_name: true, designation: true } },
        branch: true,
        lab_order: {
          include: {
            branch: true,
            patient_history: {
              include: { patient_bio_data: { select: {
                patient_id: true, patient_first_name: true, patient_middle_name: true,
                patient_last_name: true, patient_dob: true, patient_age: true,
                patient_gender: true, patient_email: true, patient_photo_url: true,
              } } },
            },
            employees: { select: { employee_id: true, first_name: true, last_name: true, designation: true } },
            department_master: true,
            lab_order_item: {
              include: {
                lab_test_master: true,
                sample_collection: true,
                lab_result: {
                  include: {
                    lab_test_parameter: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    let emailDeliveryAvailable = true;
    let deliveries: Array<{ lab_report_id: string; status: string }> = [];
    if (reports.length) {
      try {
        deliveries = await prisma.lab_report_email_delivery.findMany({
          where: { lab_report_id: { in: reports.map((report) => report.lab_report_id) } },
          orderBy: { created_at: "desc" },
          select: { lab_report_id: true, status: true },
        });
      } catch (error: any) {
        if (error?.code === "P2021" || error?.code === "42P01") emailDeliveryAvailable = false;
        else throw error;
      }
    }
    const latestByReport = new Map<string, string>();
    for (const delivery of deliveries) if (!latestByReport.has(delivery.lab_report_id)) latestByReport.set(delivery.lab_report_id, String(delivery.status));
    const portalDispatchCount = reports.filter((report) => !!report.delivered_datetime && /portal|doctor|emr|ward/i.test(report.delivered_to ?? "")).length;
    const transferredCount = reports.filter((report) =>
      latestByReport.get(report.lab_report_id) === "SENT" ||
      (!!report.delivered_datetime && /portal|doctor|emr|ward/i.test(report.delivered_to ?? "")),
    ).length;
    return {
      reports: reports.map((report) => ({
        ...report,
        branch_id: report.branch_id ?? report.lab_order?.branch_id ?? null,
        email_delivery_status: emailDeliveryAvailable ? (latestByReport.get(report.lab_report_id) ?? "PENDING") : "UNAVAILABLE",
      })),
      emailDeliveryAvailable,
      totalDispatches: portalDispatchCount + deliveries.length,
      transferred: transferredCount,
      pending: reports.filter((report) => latestByReport.get(report.lab_report_id) !== "SENT").length,
    };
  }

  async findAll() {
    return prisma.lab_report.findMany({
      orderBy: {
        id: "desc",
      },
      include: {
        employees: {
          select: {
            employee_id: true,
            first_name: true,
            last_name: true,
            designation: true,
          },
        },
        lab_order: {
          include: {
            patient_history: {
              include: {
                patient_bio_data: {
                  select: {
                    patient_id: true,
                    patient_first_name: true,
                    patient_middle_name: true,
                    patient_last_name: true,
                    patient_dob: true,
                    patient_age: true,
                    patient_gender: true,
                    patient_photo_url: true,
                  },
                },
              },
            },
            employees: {
              select: {
                employee_id: true,
                first_name: true,
                last_name: true,
                designation: true,
              },
            },
            department_master: true,
            lab_order_item: {
              include: {
                lab_test_master: true,
                sample_collection: true,
                lab_result: {
                  include: {
                    lab_test_parameter: true,
                  },
                },
              },
            },
          },
        },
        branch: true,
      },
    });
  }

  async findById(lab_report_id: string) {
    return prisma.lab_report.findUnique({
      where: { lab_report_id },
      include: {
        employees: true,
        lab_order: {
          include: {
            patient_history: true,
            employees: true,
            department_master: true,
            lab_order_item: {
              include: {
                lab_test_master: true,
                sample_collection: true,
                lab_result: {
                  include: {
                    lab_test_parameter: true,
                  },
                },
              },
            },
          },
        },
        branch: true,
      },
    });
  }

  async findByOrderId(lab_order_id: string) {
    return prisma.lab_report.findFirst({
      where: { lab_order_id },
      include: {
        employees: true,
        lab_order: {
          include: {
            patient_history: true,
            employees: true,
            department_master: true,
            lab_order_item: {
              include: {
                lab_test_master: true,
                sample_collection: true,
                lab_result: {
                  include: {
                    lab_test_parameter: true,
                  },
                },
              },
            },
          },
        },
        branch: true,
      },
    });
  }

  async create(data: {
    lab_report_id: string;
    lab_order_id: string;
    report_number?: string | null;
    generated_datetime?: Date | null;
    approved_by?: string | null;
    approved_datetime?: Date | null;
    report_status?: string | null;
    report_file?: string | null;
    digital_signature?: string | null;
    report_comment?: any;
    delivered_to?: string | null;
    delivered_datetime?: Date | null;
    branch_id?: string | null;
    user_id?: string | null;
  }) {
    const report = await prisma.lab_report.create({
      data: data as any,
      include: {
        employees: true,
        lab_order: {
          include: {
            patient_history: true,
            employees: true,
            lab_order_item: {
              include: {
                lab_test_master: true,
                sample_collection: true,
                lab_result: {
                  include: {
                    lab_test_parameter: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // Link any unassigned lab_result rows for this order to the newly created report
    if (data.lab_order_id && report.lab_report_id) {
      await prisma.lab_result.updateMany({
        where: {
          lab_order_item: {
            lab_order_id: data.lab_order_id,
          },
          lab_report_id: null,
        },
        data: {
          lab_report_id: report.lab_report_id,
        },
      }).catch(() => {});
    }

    return report;
  }

  async update(lab_report_id: string, data: any) {
    return prisma.lab_report.update({
      where: { lab_report_id },
      data,
      include: {
        employees: true,
        lab_order: {
          include: {
            patient_history: true,
            employees: true,
            lab_order_item: {
              include: {
                lab_test_master: true,
                sample_collection: true,
                lab_result: {
                  include: {
                    lab_test_parameter: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  async transfer(
    lab_report_id: string,
    data: {
      delivered_to: string;
      delivered_datetime: Date;
      report_status: string;
    }
  ) {
    return prisma.lab_report.update({
      where: { lab_report_id },
      data: {
        delivered_to: data.delivered_to,
        delivered_datetime: data.delivered_datetime,
        report_status: data.report_status,
        updated_at: new Date(),
      },
      include: {
        employees: true,
        lab_order: {
          include: {
            patient_history: true,
            employees: true,
            lab_order_item: {
              include: {
                lab_test_master: true,
                sample_collection: true,
                lab_result: {
                  include: {
                    lab_test_parameter: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  async delete(lab_report_id: string) {
    return prisma.lab_report.delete({
      where: { lab_report_id },
    });
  }
}
