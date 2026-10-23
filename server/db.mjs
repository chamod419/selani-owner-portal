import { MongoClient } from "mongodb";

let databasePromise;

export function getDatabase() {
  if (!databasePromise) {
    databasePromise = connect().catch((error) => {
      databasePromise = undefined;
      throw error;
    });
  }

  return databasePromise;
}

async function connect() {
  const template =
    process.env.MONGODB_URI_TEMPLATE?.trim();

  const password = process.env.MONGODB_PASSWORD;

  if (
    !template?.startsWith("mongodb+srv://") ||
    !password ||
    (template.match(/<(?:db_)?password>/g) || []).length !== 1 ||
    process.env.MONGODB_DB !== "selani_pos"
  ) {
    throw new Error(
      "Database configuration is incomplete.",
    );
  }

  const uri = template.replace(
    /<(?:db_)?password>/,
    () => encodeURIComponent(password),
  );

  const client = new MongoClient(uri, {
    authSource: "admin",
    appName: "SelaniOwnerPortal",
    maxPoolSize: 3,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 15000,
  });

  try {
    await client.connect();

    const db = client.db("selani_pos");

    await Promise.all([
      db.collection("sessions").createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),

      db.collection("login_limits").createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),

      db.collection("sales").createIndex(
        { storeId: 1, clientId: 1 },
        { unique: true },
      ),

      db.collection("sales").createIndex({
        storeId: 1,
        paidAt: -1,
        clientId: 1,
      }),
    ]);

    return db;
  } catch (error) {
    await client.close();
    throw error;
  }
}