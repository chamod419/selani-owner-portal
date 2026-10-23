import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";

class ConfigError extends Error {}

function getConnectionSettings() {
  const template =
    process.env.MONGODB_URI_TEMPLATE?.trim();

  const password = process.env.MONGODB_PASSWORD;
  const database = process.env.MONGODB_DB?.trim();

  if (!template?.startsWith("mongodb+srv://")) {
    throw new ConfigError(
      "Set MONGODB_URI_TEMPLATE to your Atlas SRV connection string.",
    );
  }

  if (
    !password ||
    password === "PASTE_DATABASE_PASSWORD_HERE"
  ) {
    throw new ConfigError(
      "Set MONGODB_PASSWORD to your database user's password.",
    );
  }

  if (database !== "selani_pos") {
    throw new ConfigError(
      "Set MONGODB_DB to selani_pos.",
    );
  }

  const placeholders = template.match(
    /<(?:db_)?password>/g,
  );

  if (placeholders?.length !== 1) {
    throw new ConfigError(
      "Keep exactly one <db_password> or <password> placeholder in MONGODB_URI_TEMPLATE.",
    );
  }

  const uri = template.replace(
    /<(?:db_)?password>/,
    () => encodeURIComponent(password),
  );

  if (
    /[<>]/.test(uri) ||
    uri.includes("YOUR_CLUSTER_HOST")
  ) {
    throw new ConfigError(
      "Use your real Atlas cluster address and username in MONGODB_URI_TEMPLATE.",
    );
  }

  return { uri, database };
}

async function main() {
  const { uri, database } = getConnectionSettings();

  const client = new MongoClient(uri, {
    appName: "SelaniOwnerConnectionCheck",
    authSource: "admin",
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 15000,
  });

  const testId = randomUUID();

  let collection;
  let cleanupNeeded = false;

  try {
    console.log(
      "[Selani Owner] Connecting to Atlas...",
    );

    await client.connect();

    await client.db(database).command({
      ping: 1,
    });

    console.log("[OK] Database connected.");

    collection = client
      .db(database)
      .collection("connection_checks");

    cleanupNeeded = true;

    await collection.insertOne({
      _id: testId,
      source: "selani-owner-portal",
      createdAt: new Date(),
    });

    const saved = await collection.findOne({
      _id: testId,
    });

    if (saved?.source !== "selani-owner-portal") {
      throw new Error("ConnectionCheckReadFailed");
    }

    const removed = await collection.deleteOne({
      _id: testId,
    });

    if (removed.deletedCount !== 1) {
      throw new Error("ConnectionCheckDeleteFailed");
    }

    cleanupNeeded = false;

    console.log(
      "[OK] Write, read and delete permissions verified.",
    );

    console.log(
      "[OK] Temporary test record removed.",
    );

    console.log(
      "[Selani Owner] Database setup complete.",
    );
  } finally {
    try {
      if (cleanupNeeded && collection) {
        await collection
          .deleteOne({ _id: testId })
          .catch(() => {
            console.error(
              "[NOTE] Temporary test record cleanup could not be confirmed.",
            );
          });
      }
    } finally {
      await client.close();
    }
  }
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error("[ERROR]", error.message);
  } else if (error.code === 18) {
    console.error(
      "[ERROR] Authentication failed. Check the database username and password.",
    );
  } else if (error.code === 13) {
    console.error(
      "[ERROR] Access denied. Grant readWrite access to selani_pos.",
    );
  } else if (
    error.name === "MongoServerSelectionError" ||
    error.code === "ENOTFOUND"
  ) {
    console.error(
      "[ERROR] Cannot reach Atlas. Check your internet connection, cluster address and Atlas Current IP access entry.",
    );
  } else {
    console.error(
      "[ERROR] Database check failed. Verify the Atlas connection settings and try again.",
    );
  }

  process.exitCode = 1;
});