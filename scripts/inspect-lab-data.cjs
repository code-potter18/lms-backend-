/*
 * Read-only diagnostic for the HMS lab data.
 * Usage: node scripts/inspect-lab-data.cjs [envFile] [label]
 * Never prints credentials or connection strings.
 */
const fs = require("fs");
const path = require("path");

const readEnv = (file) => {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
};

const envFile = path.resolve(process.argv[2] || path.join(__dirname, "..", ".env"));
const label = process.argv[3] || path.basename(envFile);
const env = readEnv(envFile);
const databaseUrl = process.env.INSPECT_DATABASE_URL || env.DATABASE_URL;
if (!databaseUrl) {
  console.error(`${label}: no DATABASE_URL`);
  process.exit(1);
}

// Redacted target description (host/database only).
const raw = databaseUrl;
const rest = raw.slice(raw.indexOf("://") + 3);
const hostAndDb = rest.slice(rest.lastIndexOf("@") + 1);
const slash = hostAndDb.indexOf("/");
const host = slash === -1 ? hostAndDb : hostAndDb.slice(0, slash);
const dbAndQuery = slash === -1 ? "" : hostAndDb.slice(slash + 1);
const dbName = dbAndQuery.split("?")[0];

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: raw, max: 2 }),
});

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const todayStartIst = () => {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const midnightIst = Date.UTC(
    nowIst.getUTCFullYear(),
    nowIst.getUTCMonth(),
    nowIst.getUTCDate(),
  );
  return new Date(midnightIst - IST_OFFSET_MS);
};

const money = (value) => (value === null || value === undefined ? null : Number(value));

async function main() {
  console.log(`\n===== ${label} =====`);
  console.log(`target_host=${host}`);
  console.log(`target_db=${dbName}`);
  console.log(`is_local=${/127\.0\.0\.1|localhost/.test(host)}`);

  const counts = {};
  const models = [
    "patient_bio_data",
    "patient_history",
    "lab_order",
    "lab_order_item",
    "lab_test_master",
    "lab_test_category",
    "sample_collection",
    "lab_result",
    "lab_report",
    "user_table",
    "employees",
    "branch",
    "appointment_history",
  ];
  for (const model of models) {
    try {
      counts[model] = await prisma[model].count();
    } catch (error) {
      counts[model] = `ERROR: ${String(error.message).split("\n")[0].slice(0, 120)}`;
    }
  }
  console.log("counts:", JSON.stringify(counts));

  try {
    const branches = await prisma.branch.findMany({
      select: { branch_id: true, branch_name: true, is_active: true },
      orderBy: { branch_id: "asc" },
    });
    console.log("branches:", branches.map((b) => `${b.branch_id}:${b.branch_name}:active=${b.is_active}`).join(" | "));
  } catch (error) {
    console.log("branches: ERROR", String(error.message).slice(0, 120));
  }

  const since = todayStartIst();
  console.log(`today_start_ist=${since.toISOString()}`);

  try {
    const todayPatients = await prisma.patient_bio_data.findMany({
      where: { created_at: { gte: since } },
      select: {
        patient_id: true,
        patient_first_name: true,
        patient_last_name: true,
        patient_primary_mobile: true,
        patient_email: true,
        branch_id: true,
        created_at: true,
      },
      orderBy: { created_at: "asc" },
    });
    console.log(`patients_created_today=${todayPatients.length}`);
    for (const p of todayPatients) {
      console.log(
        `  patient id=${p.patient_id} name=${[p.patient_first_name, p.patient_last_name].filter(Boolean).join(" ")} mobile=${p.patient_primary_mobile || "-"} email=${p.patient_email || "-"} branch=${p.branch_id || "-"} created=${p.created_at?.toISOString() || "-"}`,
      );
    }
  } catch (error) {
    console.log("patients_created_today: ERROR", String(error.message).slice(0, 200));
  }

  try {
    const recentPatients = await prisma.patient_bio_data.findMany({
      select: {
        patient_id: true,
        patient_first_name: true,
        patient_last_name: true,
        patient_primary_mobile: true,
        branch_id: true,
        created_at: true,
      },
      orderBy: { created_at: "desc" },
      take: 12,
    });
    console.log("recent_patients:");
    for (const p of recentPatients) {
      console.log(
        `  ${p.created_at?.toISOString() || "-"} | ${p.patient_id} | ${[p.patient_first_name, p.patient_last_name].filter(Boolean).join(" ")} | ${p.patient_primary_mobile || "-"} | branch=${p.branch_id || "-"}`,
      );
    }
  } catch (error) {
    console.log("recent_patients: ERROR", String(error.message).slice(0, 200));
  }

  try {
    const testsByStatus = await prisma.lab_test_master.groupBy({
      by: ["test_status", "branch_id"],
      _count: { _all: true },
    });
    console.log(
      "lab_tests_by_status_branch:",
      JSON.stringify(
        testsByStatus.map((row) => ({
          status: row.test_status,
          branch: row.branch_id,
          count: row._count._all,
        })),
      ),
    );
    const tests = await prisma.lab_test_master.findMany({
      select: {
        lab_test_id: true,
        test_name: true,
        test_code: true,
        price: true,
        walkin_price: true,
        test_status: true,
        branch_id: true,
        lab_test_category_id: true,
      },
      orderBy: { lab_test_id: "asc" },
      take: 15,
    });
    console.log("lab_tests_sample:");
    for (const t of tests) {
      console.log(
        `  ${t.lab_test_id} | ${t.test_code} | ${t.test_name} | price=${money(t.price)} walkin=${money(t.walkin_price)} status=${t.test_status} branch=${t.branch_id || "-"} category=${t.lab_test_category_id}`,
      );
    }
  } catch (error) {
    console.log("lab_tests: ERROR", String(error.message).slice(0, 200));
  }

  try {
    const ordersByStatus = await prisma.lab_order.groupBy({
      by: ["order_status", "branch_id"],
      _count: { _all: true },
    });
    console.log(
      "lab_orders_by_status_branch:",
      JSON.stringify(
        ordersByStatus.map((row) => ({
          status: row.order_status,
          branch: row.branch_id,
          count: row._count._all,
        })),
      ),
    );
    const orders = await prisma.lab_order.findMany({
      select: {
        lab_order_id: true,
        order_datetime: true,
        created_at: true,
        order_status: true,
        branch_id: true,
        patient_history: {
          select: {
            patient_history_id: true,
            patient_id: true,
            patient_bio_data: {
              select: {
                patient_first_name: true,
                patient_last_name: true,
                patient_primary_mobile: true,
              },
            },
          },
        },
        lab_order_item: {
          select: {
            lab_order_item_id: true,
            lab_test_id: true,
            price: true,
            item_status: true,
            lab_test_master: { select: { test_name: true, test_code: true } },
          },
        },
      },
      orderBy: { created_at: "desc" },
      take: 10,
    });
    console.log("recent_lab_orders:");
    for (const order of orders) {
      const patient = order.patient_history?.patient_bio_data;
      console.log(
        `  ${order.created_at?.toISOString() || "-"} | ${order.lab_order_id} | status=${order.order_status} | branch=${order.branch_id || "-"} | patient=${order.patient_history?.patient_id || "-"} ${[patient?.patient_first_name, patient?.patient_last_name].filter(Boolean).join(" ")} | items=${order.lab_order_item.length}`,
      );
      for (const item of order.lab_order_item) {
        console.log(
          `      item ${item.lab_order_item_id} | test=${item.lab_test_id} ${item.lab_test_master?.test_code || ""} ${item.lab_test_master?.test_name || ""} | price=${money(item.price)} | status=${item.item_status}`,
        );
      }
    }
  } catch (error) {
    console.log("lab_orders: ERROR", String(error.message).slice(0, 200));
  }

  try {
    const samples = await prisma.sample_collection.findMany({
      select: {
        sample_collection_id: true,
        lab_order_item_id: true,
        barcode: true,
        collection_status: true,
        collection_datetime: true,
        branch_id: true,
      },
      orderBy: { created_at: "desc" },
      take: 10,
    });
    console.log("recent_sample_collections:");
    for (const s of samples) {
      console.log(
        `  ${s.collection_datetime?.toISOString() || "-"} | ${s.sample_collection_id} | item=${s.lab_order_item_id} | barcode=${s.barcode || "-"} | status=${s.collection_status} | branch=${s.branch_id || "-"}`,
      );
    }
  } catch (error) {
    console.log("sample_collections: ERROR", String(error.message).slice(0, 200));
  }
}

main()
  .catch((error) => {
    console.error(`${label}: FATAL`, String(error.message).split("\n")[0].slice(0, 300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
