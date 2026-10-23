import fs from "node:fs";
import path from "node:path";

import {
  fileURLToPath,
} from "node:url";

import {
  randomBytes,
  createHash,
} from "node:crypto";

import {
  getDatabase,
} from "../server/db.mjs";

class SetupError extends Error {}

const sha = (value) =>
  createHash("sha256")
    .update(value)
    .digest("hex");

try {
  if (
    process.platform !== "win32" ||
    !process.env.APPDATA
  ) {
    throw new SetupError(
      "Run this on the Windows PC with Selani POS installed.",
    );
  }

  const args = process.argv.slice(2);
  const urlIndex = args.indexOf("--url");

  const url = new URL(
    urlIndex < 0
      ? "http://127.0.0.1:5174"
      : args[urlIndex + 1],
  );

  const local = [
    "localhost",
    "127.0.0.1",
    "[::1]",
  ].includes(url.hostname);

  if (
    (
      url.protocol !== "https:" &&
      !(local && url.protocol === "http:")
    ) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new SetupError(
      "Use the portal origin, for example https://your-site.netlify.app",
    );
  }

  const root = path.resolve(
    path.dirname(
      fileURLToPath(import.meta.url),
    ),
    "..",
  );

  const packagePath = path.resolve(
    root,
    "..",
    "selani-pos",
    "package.json",
  );

  const metadata = JSON.parse(
    fs.readFileSync(packagePath, "utf8"),
  );

  const directory =
    metadata.selaniDataDirectory;

  if (
    typeof directory !== "string" ||
    !directory.trim() ||
    /[<>:"/\\|?*\x00-\x1f]/.test(directory) ||
    [".", ".."].includes(directory)
  ) {
    throw new SetupError(
      "The sibling selani-pos project must contain the installer configuration.",
    );
  }

  const userData = path.join(
    process.env.APPDATA,
    directory,
  );

  const filename = path.join(
    userData,
    "cloud-sync.json",
  );

  let saved;

  if (fs.existsSync(filename)) {
    saved = JSON.parse(
      fs.readFileSync(filename, "utf8"),
    );
  }

  const db = await getDatabase();

  const device = await db
    .collection("sync_devices")
    .findOne({
      _id: "selani-main",
    });

  const reusable =
    /^[a-f0-9]{64}$/.test(saved?.token || "") &&
    sha(saved.token) === device?.tokenHash;

  if (
    device &&
    !reusable &&
    !args.includes("--rotate")
  ) {
    throw new SetupError(
      "Another upload key already exists. To replace it intentionally, rerun with --rotate. The previous key will stop working.",
    );
  }

  const token = reusable
    ? saved.token
    : randomBytes(32).toString("hex");

  const configuration = {
    version: 1,
    endpoint: new URL("/api/sync", url).href,
    token,
  };

  fs.mkdirSync(userData, {
    recursive: true,
  });

  const temporary = filename + ".tmp";

  fs.writeFileSync(
    temporary,
    JSON.stringify(configuration, null, 2) + "\n",
    {
      mode: 0o600,
    },
  );

  try {
    await db.collection("sync_devices").updateOne(
      {
        _id: "selani-main",
      },
      {
        $set: {
          tokenHash: sha(token),
          updatedAt: new Date(),
        },
      },
      {
        upsert: true,
      },
    );

    fs.renameSync(
      temporary,
      filename,
    );
  } finally {
    fs.rmSync(temporary, {
      force: true,
    });
  }

  console.log(
    "[OK] POS upload key configured. The key was not printed.",
  );

  console.log(
    "[OK] Configuration saved:",
    filename,
  );

  console.log(
    "[OK] Portal:",
    url.origin,
  );

  process.exit(0);
} catch (error) {
  console.error(
    "[ERROR]",

    error instanceof SetupError
      ? error.message
      : "Could not configure POS sync. Check Atlas access, the portal URL and the sibling selani-pos folder.",
  );

  process.exit(1);
}