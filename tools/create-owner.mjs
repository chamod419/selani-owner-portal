import readline from "node:readline";

import {
  createInterface,
} from "node:readline/promises";

import {
  getDatabase,
} from "../server/db.mjs";

import {
  hashPassword,
} from "../server/api.mjs";

class SetupError extends Error {}

async function secret(label) {
  if (!process.stdin.isTTY) {
    throw new SetupError(
      "Run this command in a normal PowerShell terminal.",
    );
  }

  process.stdout.write(label);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";

    function finish(error) {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }

    function onKey(text, key = {}) {
      if (key.ctrl && key.name === "c") {
        return finish(
          new SetupError("Cancelled."),
        );
      }

      if (
        key.name === "return" ||
        key.name === "enter"
      ) {
        return finish();
      }

      if (key.name === "backspace") {
        if (value) {
          value = [...value]
            .slice(0, -1)
            .join("");

          process.stdout.write("\b \b");
        }

        return;
      }

      if (
        text &&
        !key.ctrl &&
        !key.meta &&
        !/[\x00-\x1f\x7f]/.test(text)
      ) {
        value += text;

        process.stdout.write(
          "*".repeat([...text].length),
        );
      }
    }

    process.stdin.on("keypress", onKey);
  });
}

try {
  const db = await getDatabase();

  const existing = await db
    .collection("owners")
    .findOne({
      _id: "owner",
    });

  if (existing) {
    console.log(
      "[Selani Owner] Owner account already exists. No changes made.",
    );

    process.exit(0);
  }

  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const email = (
    await input.question("Owner email: ")
  )
    .trim()
    .toLowerCase();

  input.close();

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254
  ) {
    throw new SetupError(
      "Enter a valid email address.",
    );
  }

  const password = await secret(
    "Owner password (12-128 characters): ",
  );

  if (
    password.length < 12 ||
    password.length > 128
  ) {
    throw new SetupError(
      "Use a password with 12-128 characters.",
    );
  }

  const confirmation = await secret(
    "Confirm password: ",
  );

  if (password !== confirmation) {
    throw new SetupError(
      "Passwords do not match.",
    );
  }

  await db.collection("owners").insertOne({
    _id: "owner",
    email,
    passwordHash: await hashPassword(password),
    createdAt: new Date(),
  });

  console.log(
    "[OK] Owner account created. Use this email and password to log in.",
  );

  process.exit(0);
} catch (error) {
  console.error(
    "[ERROR]",
    error instanceof SetupError
      ? error.message
      : "Could not create the owner account. Check Atlas access and run npm run db:test.",
  );

  process.exit(1);
}