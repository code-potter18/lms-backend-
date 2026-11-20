import prisma from "../../config/prisma";
import {
  PatientProfileResponse,
  UpdatePatientContactDTO,
  PatientDashboardResponse,
  PatientLabTestItem,
  PatientTestMilestone,
  PatientReportItem,
  PatientNotificationItem,
} from "./patient-portal.types";

export class PatientPortalService {
  /**
   * Resolve patient profile strictly from authenticated patient_id
   */
  async getProfile(patientId: string): Promise<PatientProfileResponse> {
    const patient = await prisma.patient_bio_data.findFirst({
      where: { patient_id: patientId },
      include: { branch: true, user_table: true },
    });

    if (!patient) {
      throw new Error("Patient record not found");
    }

    const fullName = [
      patient.patient_first_name,
      patient.patient_middle_name,
      patient.patient_last_name,
    ]
      .filter(Boolean)
      .join(" ");

    return {
      patient_id: patient.patient_id || "",
      patient_first_name: patient.patient_first_name,
      patient_middle_name: patient.patient_middle_name,
      patient_last_name: patient.patient_last_name,
      full_name: fullName,
      patient_dob: patient.patient_dob ? patient.patient_dob.toISOString().split("T")[0] : null,
      patient_age: patient.patient_age,
      patient_gender: patient.patient_gender,
      patient_blood_group: patient.patient_blood_group,
      patient_primary_mobile: patient.patient_primary_mobile,
      patient_alternate_mobile: patient.patient_alternate_mobile,
      patient_email: patient.patient_email,
      patient_address: (patient as any).Patient_address || (patient as any).patient_address || null,
      patient_area: patient.patient_area,
      patient_district: patient.patient_district,
      patient_state: patient.patient_state,
      patient_pincode: patient.patient_pincode ? Number(patient.patient_pincode) : null,
      emergency_contact_name: (patient as any).Patient_Emergency_contact_name || (patient as any).emergency_contact_name || null,
      emergency_contact_relation: (patient as any).Emergency_contact_relation || (patient as any).emergency_contact_relation || null,
      emergency_contact_number: (patient as any).Patient_emergency_mobile || (patient as any).emergency_contact_number || null,
      branch_id: patient.branch_id,
      branch_name: patient.branch?.branch_name || null,
      created_at: patient.user_table?.created_at ? patient.user_table.created_at.toISOString() : null,
    };
  }

  /**
   * Update allowed patient contact details only
   */
  async updateProfile(patientId: string, data: UpdatePatientContactDTO): Promise<{ success: boolean; message: string }> {
    const patient = await prisma.patient_bio_data.findFirst({
      where: { patient_id: patientId },
    });

    if (!patient) {
      throw new Error("Patient record not found");
    }

    const updateData: any = {};
    if (data.patient_email !== undefined) {
      const emailTrimmed = data.patient_email?.trim() || null;
      if (emailTrimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)) {
        throw new Error("Invalid email format");
      }
      updateData.patient_email = emailTrimmed;
    }
    if (data.patient_alternate_mobile !== undefined) {
      updateData.patient_alternate_mobile = data.patient_alternate_mobile?.trim() || null;
    }
    if (data.patient_address !== undefined) {
      updateData.Patient_address = data.patient_address?.trim() || null;
    }
    if (data.patient_area !== undefined) {
      updateData.patient_area = data.patient_area?.trim() || null;
    }
    if (data.patient_district !== undefined) {
      updateData.patient_district = data.patient_district?.trim() || null;
    }
    if (data.patient_state !== undefined) {
      updateData.patient_state = data.patient_state?.trim() || null;
    }
    if (data.patient_pincode !== undefined) {
      updateData.patient_pincode = data.patient_pincode ? Number(data.patient_pincode) : null;
    }
    if (data.emergency_contact_name !== undefined) {
      updateData.Patient_Emergency_contact_name = data.emergency_contact_name?.trim() || null;
    }
    if (data.emergency_contact_relation !== undefined) {
      updateData.Emergency_contact_relation = data.emergency_contact_relation?.trim() || null;
    }
    if (data.emergency_contact_number !== undefined) {
      updateData.Patient_emergency_mobile = data.emergency_contact_number?.trim() || null;
    }

    await prisma.patient_bio_data.update({
      where: { id: patient.id },
      data: updateData,
    });

    return {
      success: true,
      message: "Contact information updated successfully",
    };
  }

  /**
   * Helper: Check if a test item has had testing completed (results entered/saved)
   */
  private isTestTestingCompleted(item: any): boolean {
    const rawStatus = (item.item_status || "").trim().toLowerCase();
    if (["completed", "report generated", "delivered"].includes(rawStatus)) {
      return true;
    }
    const results = item.lab_result || [];
    if (results.length > 0) {
      return results.some((r: any) => r.result_value && String(r.result_value).trim() !== "");
    }
    return false;
  }

  /**
   * Helper: Check if a test item has had all required parameters QC reviewed and approved
   */
  private isTestQCApproved(item: any): boolean {
    const results = item.lab_result || [];
    if (results.length === 0) return false;
    return results.every(
      (r: any) =>
        r.result_value &&
        String(r.result_value).trim() !== "" &&
        (r.result_status || "").trim().toLowerCase() === "approved"
    );
  }

  /**
   * Helper: Check if a report has been approved by an authorized clinician
   */
  private isReportApproved(report: any): boolean {
    if (!report) return false;
    const status = (report.report_status || "").trim().toLowerCase();
    if (status === "draft") return false;
    const hasApprovedDatetime = report.approved_datetime !== null && report.approved_datetime !== undefined;
    const hasFile = Boolean(report.report_file);
    const hasApprover = Boolean(report.approved_by || report.digital_signature);
    return hasApprovedDatetime && hasFile && hasApprover;
  }

  /**
   * Helper: Check if a report has completed the Report Transfer / Release workflow
   */
  private isReportReleased(report: any): boolean {
    if (!report) return false;
    const status = (report.report_status || "").trim().toLowerCase();
    if (status === "delivered" || status === "released" || status === "sent") return true;
    if (report.delivered_datetime !== null && report.delivered_datetime !== undefined) return true;
    if (report.delivered_to && String(report.delivered_to).trim().length > 0) return true;
    const emailDeliveries = report.lab_report_email_delivery || [];
    if (emailDeliveries.some((e: any) => ["SENT", "DELIVERED"].includes(String(e.status).toUpperCase()))) {
      return true;
    }
    const waDeliveries = report.whatsapp_delivery || [];
    if (waDeliveries.some((w: any) => ["SENT", "DELIVERED"].includes(String(w.delivery_status).toUpperCase()))) {
      return true;
    }
    return false;
  }

  /**
   * Helper: Check if a report is genuinely approved AND released for patient delivery
   */
  private isReportApprovedAndReleased(report: any): boolean {
    return this.isReportApproved(report) && this.isReportReleased(report);
  }

  /**
   * Helper to retrieve all lab order IDs belonging strictly to this patient
   */
  private async getPatientLabOrders(patientId: string) {
    const histories = await prisma.patient_history.findMany({
      where: { patient_id: patientId },
      select: {
        patient_history_id: true,
        lab_order: {
          include: {
            branch: true,
            lab_order_item: {
              include: {
                lab_test_master: {
                  include: {
                    lab_test_category: true,
                  },
                },
                sample_collection: true,
                lab_result: true,
              },
            },
            lab_report: {
              include: {
                lab_report_email_delivery: true,
                whatsapp_delivery: true,
              },
            },
          },
          orderBy: { created_at: "desc" },
        },
      },
    });

    const orders: any[] = [];
    for (const h of histories) {
      if (h.lab_order && h.lab_order.length > 0) {
        orders.push(...h.lab_order);
      }
    }

    // Sort orders by creation date descending
    orders.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return orders;
  }

  /**
   * Patient Dashboard data
   */
  async getDashboard(patientId: string): Promise<PatientDashboardResponse> {
    const patient = await prisma.patient_bio_data.findFirst({
      where: { patient_id: patientId },
    });

    if (!patient) {
      throw new Error("Patient record not found");
    }

    const patientName = [patient.patient_first_name, patient.patient_last_name].filter(Boolean).join(" ");
    const orders = await this.getPatientLabOrders(patientId);

    let totalTests = 0;
    let testsInProgress = 0;
    let completedTests = 0;
    const allApprovedReports: any[] = [];
    const seenReportIds = new Set<string>();

    const recentOrders: any[] = [];

    for (const order of orders) {
      const items = order.lab_order_item || [];
      totalTests += items.length;

      const releasedReport = (order.lab_report || []).find((r: any) => this.isReportApprovedAndReleased(r));
      const isOrderReleased = Boolean(releasedReport);

      for (const item of items) {
        const isTestingDone = this.isTestTestingCompleted(item);
        if (isTestingDone) {
          completedTests++;
        } else {
          testsInProgress++;
        }
      }

      if (order.lab_report && order.lab_report.length > 0) {
        for (const rep of order.lab_report) {
          if (this.isReportApprovedAndReleased(rep) && !seenReportIds.has(rep.lab_report_id)) {
            seenReportIds.add(rep.lab_report_id);
            allApprovedReports.push({
              report: rep,
              order,
            });
          }
        }
      }

      if (recentOrders.length < 5) {
        recentOrders.push({
          lab_order_id: order.lab_order_id,
          created_at: order.created_at ? order.created_at.toISOString() : "",
          order_status: isOrderReleased ? "Completed" : (order.order_status || "Active"),
          tests: items.map((i: any) => ({
            lab_order_item_id: i.lab_order_item_id,
            test_name: i.lab_test_master?.test_name || "Lab Test",
            category_name: i.lab_test_master?.lab_test_category?.category_name || null,
            item_status: this.isTestTestingCompleted(i) ? "Completed" : (i.item_status || "Pending"),
          })),
        });
      }
    }

    // Recent reports (up to 5)
    const recentReports = allApprovedReports.slice(0, 5).map(({ report, order }) => {
      const testNames = (order.lab_order_item || [])
        .map((i: any) => i.lab_test_master?.test_name)
        .filter(Boolean);
      return {
        lab_report_id: report.lab_report_id,
        lab_order_id: order.lab_order_id,
        approved_datetime: report.approved_datetime ? report.approved_datetime.toISOString() : null,
        report_status: report.report_status || "Approved",
        test_names: testNames.length > 0 ? testNames : ["Laboratory Test Report"],
        has_pdf: Boolean(report.report_file),
      };
    });

    const notifications = await this.getNotifications(patientId);

    return {
      patient_id: patientId,
      patient_name: patientName,
      metrics: {
        total_tests: totalTests,
        tests_in_progress: testsInProgress,
        completed_tests: completedTests,
        approved_reports: allApprovedReports.length,
      },
      recent_orders: recentOrders,
      recent_reports: recentReports,
      recent_notifications: notifications.notifications.slice(0, 5),
    };
  }

  /**
   * My Lab Tests list with search, filter, and multi-test order grouping
   */
  async getLabTests(
    patientId: string,
    filter?: { search?: string; status?: string }
  ): Promise<PatientLabTestItem[]> {
    const orders = await this.getPatientLabOrders(patientId);
    const search = (filter?.search || "").toLowerCase().trim();
    const statusFilter = (filter?.status || "").toLowerCase().trim();

    const items: PatientLabTestItem[] = [];

    for (const order of orders) {
      const releasedReport = (order.lab_report || []).find((r: any) => this.isReportApprovedAndReleased(r));
      const isOrderReleased = Boolean(releasedReport);
      const hasPendingApproval = (order.lab_report || []).some(
        (r: any) => this.isReportReleased(r) && !this.isReportApproved(r)
      );

      for (const item of order.lab_order_item || []) {
        const testName = item.lab_test_master?.test_name || "Lab Test";
        const categoryName = item.lab_test_master?.lab_test_category?.category_name || "General";
        const sample = item.sample_collection?.[0];
        const rawItemStatus = (item.item_status || "Pending").toLowerCase();
        const isTestingDone = this.isTestTestingCompleted(item);
        const isQCApproved = this.isTestQCApproved(item);

        let resolvedStatus = "Sample Collection Pending";

        if (isOrderReleased) {
          resolvedStatus = "Report Approved & Available";
        } else if (hasPendingApproval) {
          resolvedStatus = "Report Pending Approval";
        } else if (isQCApproved) {
          resolvedStatus = "QC Approved / Report Pending Transfer";
        } else if (isTestingDone) {
          resolvedStatus = "Testing Completed / QC Review Pending";
        } else if (
          rawItemStatus.includes("in-progress") ||
          rawItemStatus.includes("testing") ||
          rawItemStatus.includes("running")
        ) {
          resolvedStatus = "Testing In Progress";
        } else if (rawItemStatus.includes("verif")) {
          resolvedStatus = "Sample Verified";
        } else if (sample?.collection_status === "Collected" || rawItemStatus.includes("collect")) {
          resolvedStatus = "Sample Collected";
        } else {
          resolvedStatus = "Sample Collection Pending";
        }

        let resolvedCollectionStatus = "Pending Collection";
        if (sample?.collection_status) {
          resolvedCollectionStatus = sample.collection_status;
        } else if (sample) {
          resolvedCollectionStatus = "Collected";
        } else if (isTestingDone || rawItemStatus.includes("verif") || rawItemStatus.includes("test")) {
          resolvedCollectionStatus = "Collected";
        }

        if (search) {
          const match =
            testName.toLowerCase().includes(search) ||
            categoryName.toLowerCase().includes(search) ||
            order.lab_order_id.toLowerCase().includes(search) ||
            (sample?.barcode || "").toLowerCase().includes(search);
          if (!match) continue;
        }

        if (statusFilter && statusFilter !== "all") {
          if (statusFilter === "completed" && !isOrderReleased) continue;
          if (statusFilter === "in-progress" && isOrderReleased) continue;
        }

        items.push({
          lab_order_id: order.lab_order_id,
          lab_order_item_id: item.lab_order_item_id,
          order_date: order.created_at ? order.created_at.toISOString() : "",
          test_name: testName,
          test_category: categoryName,
          sample_type: item.lab_test_master?.sample_type || sample?.container_type || "Blood",
          barcode: sample?.barcode || null,
          status: resolvedStatus,
          sample_status: resolvedCollectionStatus,
          branch_name: order.branch?.branch_name || null,
          expected_date: item.target_date ? item.target_date.toISOString() : null,
        });
      }
    }

    return items;
  }

  /**
   * Real milestone progress tracking without exposing internal staff notes
   */
  async getTestStatus(patientId: string): Promise<PatientTestMilestone[]> {
    const orders = await this.getPatientLabOrders(patientId);
    const result: PatientTestMilestone[] = [];

    for (const order of orders) {
      const releasedReport = (order.lab_report || []).find((r: any) => this.isReportApprovedAndReleased(r));
      const isOrderReleased = Boolean(releasedReport);
      const hasPendingApproval = (order.lab_report || []).some(
        (r: any) => this.isReportReleased(r) && !this.isReportApproved(r)
      );

      for (const item of order.lab_order_item || []) {
        const testName = item.lab_test_master?.test_name || "Lab Test";
        const sample = item.sample_collection?.[0];
        const rawItemStatus = (item.item_status || "Pending").toLowerCase();
        const isTestingDone = this.isTestTestingCompleted(item);
        const isQCApproved = this.isTestQCApproved(item);

        let stageIndex = 0;
        let currentStage = "Sample Collection Pending";

        if (isOrderReleased) {
          stageIndex = 6;
          currentStage = "Report Approved & Available";
        } else if (hasPendingApproval) {
          stageIndex = 5;
          currentStage = "Report Pending Approval";
        } else if (isQCApproved) {
          stageIndex = 5;
          currentStage = "QC Approved / Report Pending Transfer";
        } else if (isTestingDone) {
          stageIndex = 4;
          currentStage = "Testing Completed / QC Review Pending";
        } else if (
          rawItemStatus.includes("in-progress") ||
          rawItemStatus.includes("testing") ||
          rawItemStatus.includes("running")
        ) {
          stageIndex = 3;
          currentStage = "Testing In Progress";
        } else if (rawItemStatus.includes("verif")) {
          stageIndex = 2;
          currentStage = "Sample Verified";
        } else if (sample?.collection_status === "Collected" || rawItemStatus.includes("collect")) {
          stageIndex = 1;
          currentStage = "Sample Collected";
        } else {
          stageIndex = 0;
          currentStage = "Sample Collection Pending";
        }

        const stages = [
          { stage: "REGISTERED", label: "Test Registered", order: 0 },
          { stage: "SAMPLE_COLLECTED", label: "Sample Collected", order: 1 },
          { stage: "SAMPLE_VERIFIED", label: "Sample Verified", order: 2 },
          { stage: "TESTING", label: "Testing In Progress", order: 3 },
          { stage: "TESTING_COMPLETED", label: "Testing Completed", order: 4 },
          { stage: "QC_APPROVED", label: "QC Approved", order: 5 },
          { stage: "REPORT_AVAILABLE", label: "Report Available", order: 6 },
        ];

        const milestones = stages.map((s) => ({
          stage: s.stage,
          label: s.label,
          completed: stageIndex >= s.order,
          current: stageIndex === s.order,
          date: s.order === 0 && order.created_at ? order.created_at.toISOString() : null,
        }));

        result.push({
          order_id: order.lab_order_id,
          item_id: item.lab_order_item_id,
          test_name: testName,
          current_stage: currentStage,
          stage_index: stageIndex,
          milestones,
        });
      }
    }

    return result;
  }

  /**
   * My Reports: only genuinely approved AND released reports.
   * Multi-test orders are consolidated into ONE combined PDF report item.
   */
  async getApprovedReports(patientId: string): Promise<PatientReportItem[]> {
    const orders = await this.getPatientLabOrders(patientId);
    const reports: PatientReportItem[] = [];
    const seenReportIds = new Set<string>();

    for (const order of orders) {
      for (const rep of order.lab_report || []) {
        if (!this.isReportApprovedAndReleased(rep)) {
          continue;
        }

        if (seenReportIds.has(rep.lab_report_id)) continue;
        seenReportIds.add(rep.lab_report_id);

        const testNames = (order.lab_order_item || [])
          .map((i: any) => i.lab_test_master?.test_name)
          .filter(Boolean);

        reports.push({
          lab_report_id: rep.lab_report_id,
          lab_order_id: order.lab_order_id,
          test_names: testNames.length > 0 ? testNames : ["Laboratory Test Report"],
          report_date: rep.created_at ? rep.created_at.toISOString() : order.created_at.toISOString(),
          approved_date: rep.approved_datetime ? rep.approved_datetime.toISOString() : null,
          approved_by: rep.approved_by || "Authorized Pathologist",
          report_status: rep.report_status || "Approved",
          has_pdf: Boolean(rep.report_file),
        });
      }
    }

    return reports;
  }

  /**
   * Secure PDF download & viewing with strict ownership verification
   */
  async getReportPdf(patientId: string, reportId: string) {
    const report = await prisma.lab_report.findFirst({
      where: { lab_report_id: reportId },
      include: {
        lab_order: {
          include: {
            patient_history: true,
          },
        },
        lab_report_email_delivery: true,
        whatsapp_delivery: true,
      },
    });

    if (!report) {
      throw new Error("Report not found");
    }

    // Strict ownership verification: must match authenticated patient's patient_id
    const orderPatientId = report.lab_order?.patient_history?.patient_id;
    if (orderPatientId !== patientId) {
      throw new Error("Access denied: You do not have permission to view this report");
    }

    if (!this.isReportApprovedAndReleased(report)) {
      throw new Error("This report has not yet completed the full approval and release workflow");
    }

    if (!report.report_file) {
      throw new Error("Report PDF is not available yet. Please contact the laboratory.");
    }

    return {
      reportId: report.lab_report_id,
      orderId: report.lab_order_id,
      pdfData: report.report_file,
      approvedDate: report.approved_datetime,
    };
  }

  /**
   * In-app notifications with deduplication & defensive fallback
   */
  async getNotifications(patientId: string): Promise<{ notifications: PatientNotificationItem[]; unreadCount: number }> {
    try {
      const records: any[] = await prisma.$queryRawUnsafe(
        `SELECT notification_id, title, message, event_type, reference_id, is_read, created_at 
         FROM "patient_notification" 
         WHERE patient_id = $1 
         ORDER BY created_at DESC 
         LIMIT 50`,
        patientId
      );

      const notifications: PatientNotificationItem[] = records.map((r) => ({
        notification_id: r.notification_id,
        title: r.title,
        message: r.message,
        event_type: r.event_type,
        reference_id: r.reference_id,
        is_read: Boolean(r.is_read),
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      }));

      const unreadCount = notifications.filter((n) => !n.is_read).length;
      return { notifications, unreadCount };
    } catch (err: any) {
      // If table doesn't exist yet, return empty list safely without crashing
      return { notifications: [], unreadCount: 0 };
    }
  }

  async markNotificationRead(patientId: string, notificationId: string): Promise<boolean> {
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "patient_notification" SET is_read = true WHERE notification_id = $1 AND patient_id = $2`,
        notificationId,
        patientId
      );
      return true;
    } catch {
      return false;
    }
  }

  async markAllNotificationsRead(patientId: string): Promise<boolean> {
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "patient_notification" SET is_read = true WHERE patient_id = $1`,
        patientId
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create an in-app notification with strict deduplication
   */
  static async createNotification(
    patientId: string,
    title: string,
    message: string,
    eventType: string,
    referenceId?: string
  ) {
    try {
      // Check deduplication
      if (referenceId) {
        const existing: any[] = await prisma.$queryRawUnsafe(
          `SELECT notification_id FROM "patient_notification" 
           WHERE patient_id = $1 AND event_type = $2 AND reference_id = $3 LIMIT 1`,
          patientId,
          eventType,
          referenceId
        );
        if (existing && existing.length > 0) {
          return null; // Already notified
        }
      }

      const notifId = `PNOTIF${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "patient_notification" 
         (notification_id, patient_id, title, message, event_type, reference_id, is_read, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, false, NOW())`,
        notifId,
        patientId,
        title,
        message,
        eventType,
        referenceId || null
      );
      return notifId;
    } catch (err: any) {
      console.warn("Could not record patient notification (table pending or offline):", err.message);
      return null;
    }
  }
}
