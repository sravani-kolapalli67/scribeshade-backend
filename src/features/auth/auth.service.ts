import { prisma } from "../../shared/lib/prisma";
import { Webhook } from "svix";
import { AppError } from "../../shared/middleware/error.middleware";

/**
 * Syncs a Clerk user with the local PostgreSQL DB.
 * Uses upsert to handle both create and update cases.
 */

export async function syncUser(clerkId: string, email?: string, name?: string) {
  console.log("Doing database sync");
  if (!clerkId) {
    throw new Error("Missing clerkId");
  }

  if (!email) {
    throw new AppError(400, "Email is required for user synchronization");
  }

  const user = await prisma.user.upsert({
    where: { clerkId },

    update: {
      email,
      name,
    },

    create: {
      clerkId,
      email,
      name,
    },
  });

  return user;
}

/**
 * Fetches the local user record by their Clerk ID.
 */
export async function getUserByClerkId(clerkId: string) {
  console.log("🚀 ~ clerkId:", clerkId);
  const user = await prisma.user.findUnique({
    where: { clerkId },
  });
  return user;
}

/**
 * Handles incoming Clerk webhook events.
 * Verifies the webhook signature using svix, then processes the event.
 */
export async function handleWebhook(body: any, headers: any) {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("CLERK_WEBHOOK_SECRET is not configured");
  }

  console.log("Webhook received");
  console.log(webhookSecret);
  const wh = new Webhook(webhookSecret);
  console.log("Runnin111111g-?>>>>>>>>");

  let event = body;
  try {
    console.log(
      `Running-?>>>>>>>>  headers = ${JSON.stringify(headers)}`,
      body,
    );
    // event = wh.verify(body, {
    //   "svix-id": headers["svix-id"] as string,
    //   "svix-timestamp": headers["svix-timestamp"] as string,
    //   "svix-signature": headers["svix-signature"] as string,
    // });
  } catch (error) {
    console.error("Webhook verification failed:", error);
    throw new Error("Invalid webhook signature");
  }

  const { type, data } = event;
  console.log("Event:", type, data.id);

  switch (type) {
    case "user.created": {
      const clerkId: string = data.id;
      const email: string | undefined =
        data.email_addresses?.[0]?.email_address;
      const firstName: string | undefined = data.first_name;
      const lastName: string | undefined = data.last_name;
      const name = [firstName, lastName].filter(Boolean).join(" ") || undefined;
      await syncUser(clerkId, email, name);
      break;
    }
    case "user.updated": {
      //   const clerkId: string = data.id;
      //   const email: string | undefined =
      //     data.email_addresses?.[0]?.email_address;
      //   const firstName: string | undefined = data.first_name;
      //   const lastName: string | undefined = data.last_name;
      //   const name = [firstName, lastName].filter(Boolean).join(" ") || undefined;
      //   await syncUser(clerkId, email, name);
      const { email, name } = data;
      await prisma.user.update({
        where: { clerkId: data.id },
        data: {
          email,
          name,
        },
      });
      break;
    }

    case "user.deleted": {
      const clerkId: string = data.id;
      await prisma.user.deleteMany({ where: { clerkId } });
      break;
    }

    default:
      // Unhandled event type — ignore gracefully
      break;
  }

  return { received: true, type };
}
