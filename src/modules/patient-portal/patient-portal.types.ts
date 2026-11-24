export interface PatientProfileResponse {
  patient_id: string;
  patient_first_name: string;
  patient_middle_name: string | null;
  patient_last_name: string | null;
  full_name: string;
  patient_dob: string | null;
  patient_age: number | null;
  patient_gender: string | null;
  patient_blood_group: string | null;
  patient_primary_mobile: string | null;
  patient_alternate_mobile: string | null;
  patient_email: string | null;
  patient_address: string | null;
  patient_area: string | null;
  patient_district: string | null;
  patient_state: string | null;
  patient_pincode: number | null;
  emergency_contact_name: string | null;
  emergency_contact_relation: string | null;
  emergency_contact_number: string | null;
  branch_id: string | null;
  branch_name: string | null;
  created_at: string | null;
}

export interface UpdatePatientContactDTO {
  patient_email?: string;
  patient_alternate_mobile?: string;
  patient_address?: string;
  patient_area?: string;
  patient_district?: string;
  patient_state?: string;
  patient_pincode?: number;
  emergency_contact_name?: string;
  emergency_contact_relation?: string;
  emergency_contact_number?: string;
  operation_id?: string;
}

export interface PatientDashboardResponse {
  patient_id: string;
  patient_name: string;
  metrics: {
    total_tests: number;
    tests_in_progress: number;
    completed_tests: number;
    approved_reports: number;
  };
  recent_orders: Array<{
    lab_order_id: string;
    created_at: string;
    order_status: string;
    tests: Array<{
      lab_order_item_id: string;
      test_name: string;
      category_name: string | null;
      item_status: string;
    }>;
  }>;
  recent_reports: Array<{
    lab_report_id: string;
    lab_order_id: string;
    approved_datetime: string | null;
    report_status: string;
    test_names: string[];
    has_pdf: boolean;
  }>;
  recent_notifications: Array<{
    notification_id: string;
    title: string;
    message: string;
    event_type: string;
    created_at: string;
    is_read: boolean;
  }>;
}

export interface PatientLabTestItem {
  lab_order_id: string;
  lab_order_item_id: string;
  order_date: string;
  test_name: string;
  test_category: string;
  sample_type: string | null;
  barcode: string | null;
  status: string;
  sample_status: string | null;
  branch_name: string | null;
  expected_date: string | null;
}

export interface PatientTestMilestone {
  order_id: string;
  item_id: string;
  test_name: string;
  current_stage: string;
  stage_index: number;
  milestones: Array<{
    stage: string;
    label: string;
    completed: boolean;
    current: boolean;
    date: string | null;
  }>;
}

export interface PatientReportItem {
  lab_report_id: string;
  lab_order_id: string;
  test_names: string[];
  report_date: string;
  approved_date: string | null;
  approved_by: string | null;
  report_status: string;
  has_pdf: boolean;
}

export interface PatientNotificationItem {
  notification_id: string;
  title: string;
  message: string;
  event_type: string;
  reference_id: string | null;
  is_read: boolean;
  created_at: string;
}
