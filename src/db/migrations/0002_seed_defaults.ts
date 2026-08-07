/**
 * Seed default resource quota tiers and the bootstrap admin account.
 *
 * Idempotent: only inserts when rows are absent.
 */
import bcrypt from "bcrypt";
import { loadConfig } from "../../config.ts";
import { encodeJson, type SqlValue } from "../driver.ts";
import type { Migration } from "../migrate.ts";

const QUOTA_TIERS = [
  {
    name: "default",
    description: "Standard user quota",
    max_containers: 2,
    max_cpu_cores: 2,
    max_memory_mb: 2048,
    max_disk_gb: 10,
    max_snapshots_per_container: 5,
  },
  {
    name: "admin",
    description: "Elevated quota for administrators",
    max_containers: 10,
    max_cpu_cores: 8,
    max_memory_mb: 16384,
    max_disk_gb: 50,
    max_snapshots_per_container: 20,
  },
  {
    name: "enterprise",
    description: "High-capacity tier for power users",
    max_containers: 20,
    max_cpu_cores: 16,
    max_memory_mb: 32768,
    max_disk_gb: 100,
    max_snapshots_per_container: 50,
  },
];

const SAMPLE_IMAGES = [
  {
    name: "ubuntu-22.04",
    display_name: "Ubuntu 22.04 LTS",
    sif_path: "/srv/apptainer/images/ubuntu-22.04.sif",
    description: "Minimal Ubuntu 22.04 LTS base image",
    tags: ["linux", "ubuntu", "base"],
    default_resources: { cpu: 1, memoryMb: 1024, diskGb: 5 },
  },
  {
    name: "node-20",
    display_name: "Node.js 20 (Bookworm)",
    sif_path: "/srv/apptainer/images/node-20.sif",
    description: "Node.js 20 runtime on Debian Bookworm",
    tags: ["linux", "node", "javascript"],
    default_resources: { cpu: 1, memoryMb: 2048, diskGb: 5 },
  },
  {
    name: "python-3.12",
    display_name: "Python 3.12 (Slim)",
    sif_path: "/srv/apptainer/images/python-3.12.sif",
    description: "Python 3.12 slim image for data and scripting work",
    tags: ["linux", "python", "data"],
    default_resources: { cpu: 1, memoryMb: 2048, diskGb: 5 },
  },
];

export const up: Migration["up"] = async ({ db }) => {
  for (const tier of QUOTA_TIERS) {
    const existing = await db.get<{ id: number }>("SELECT id FROM resource_quotas WHERE name = ?", tier.name);
    if (!existing) {
      await db.run(
        `INSERT INTO resource_quotas
          (name, description, max_containers, max_cpu_cores, max_memory_mb, max_disk_gb, max_snapshots_per_container)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        tier.name,
        tier.description,
        tier.max_containers,
        tier.max_cpu_cores,
        tier.max_memory_mb,
        tier.max_disk_gb,
        tier.max_snapshots_per_container,
      );
    }
  }

  const config = loadConfig();
  const admin = await db.get<{ id: number }>("SELECT id FROM users WHERE username = ?", config.seed.adminUsername);
  if (!admin) {
    const quota = await db.get<{ id: number }>("SELECT id FROM resource_quotas WHERE name = 'admin'");
    if (!quota) throw new Error("admin quota tier missing; cannot seed admin user");
    const passwordHash = await bcrypt.hash(config.seed.adminPassword, 12);
    await db.run(
      `INSERT INTO users (username, password_hash, email, role, quota_id, status)
       VALUES (?, ?, ?, 'admin', ?, 'active')`,
      config.seed.adminUsername,
      passwordHash,
      "admin@localhost",
      quota.id,
    );
  }

  for (const image of SAMPLE_IMAGES) {
    const existing = await db.get<{ id: number }>("SELECT id FROM images WHERE name = ?", image.name);
    if (existing) continue;
    await db.run(
      `INSERT INTO images (name, display_name, sif_path, description, is_public, tags, default_resources)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      image.name,
      image.display_name,
      image.sif_path,
      image.description,
      true,
      encodeJson(image.tags, db.dialect) as SqlValue,
      encodeJson(image.default_resources, db.dialect) as SqlValue,
    );
  }
};

export const down: Migration["down"] = async ({ db }) => {
  const config = loadConfig();
  await db.run("DELETE FROM users WHERE username = ?", config.seed.adminUsername);
  await db.run("DELETE FROM images WHERE name IN (?, ?, ?)", "ubuntu-22.04", "node-20", "python-3.12");
  // Keep quota tiers; they are reference data.
};

const migration: Migration = { id: "0002_seed_defaults", up, down };
export default migration;
