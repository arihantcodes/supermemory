"use server";

import { revalidatePath } from "next/cache";
import { db } from "../../server/db";
import {
  canvas,
  chatHistory,
  chatThreads,
  contentToSpace,
  space,
  spacesAccess,
  storedContent,
  users,
} from "../../server/db/schema";
import { ServerActionReturnType } from "./types";
import { auth } from "../../server/auth";
import { Tweet } from "react-tweet/api";
import { getMetaData } from "@/lib/get-metadata";
import { and, eq, inArray, sql } from "drizzle-orm";
import { LIMITS } from "@/lib/constants";
import { ChatHistory } from "@repo/shared-types";
import { decipher } from "@/server/encrypt";
import { redirect } from "next/navigation";
import { tweetToMd } from "@repo/shared-types/utils";

export const createSpace = async (
  input: string | FormData,
): ServerActionReturnType<number> => {
  const data = await auth();

  if (!data || !data.user) {
    redirect("/signin");
    return { error: "Not authenticated", success: false };
  }

  if (typeof input === "object") {
    input = (input as FormData).get("name") as string;
  }

  try {
    const resp = await db
      .insert(space)
      .values({ name: input, user: data.user.id, createdAt: new Date() });

    revalidatePath("/home");
    return { success: true, data: resp.meta.last_row_id };
  } catch (e: unknown) {
    const error = e as Error;
    if (
      error.message.includes("D1_ERROR: UNIQUE constraint failed: space.name")
    ) {
      return { success: false, data: 0, error: "Space already exists" };
    } else {
      return {
        success: false,
        data: 0,
        error: "Failed to create space with error: " + error.message,
      };
    }
  }
};

const typeDecider = (content: string) => {
  // if the content is a URL, then it's a page. if its a URL with https://x.com/user/status/123, then it's a tweet. else, it's a note.
  // do strict checking with regex
  if (content.match(/https?:\/\/(x\.com|twitter\.com)\/[\w]+\/[\w]+\/[\d]+/)) {
    return "tweet";
  } else if (content.match(/https?:\/\/[\w\.]+/)) {
    return "page";
  } else if (content.match(/https?:\/\/www\.[\w\.]+/)) {
    return "page";
  } else {
    return "note";
  }
};

export const limit = async (
  userId: string,
  type = "page",
  items: number = 1,
) => {
  const countResult = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(storedContent)
    .where(and(eq(storedContent.userId, userId), eq(storedContent.type, type)));

  const currentCount = countResult[0]?.count || 0;
  const totalLimit = LIMITS[type as keyof typeof LIMITS];
  const remainingLimit = totalLimit - currentCount;

  return items <= remainingLimit;
};

export const addUserToSpace = async (userEmail: string, spaceId: number) => {
  const data = await auth();

  if (!data || !data.user || !data.user.id) {
    redirect("/signin");
    return { error: "Not authenticated", success: false };
  }

  // We need to make sure that the user owns the space
  const spaceData = await db
    .select()
    .from(space)
    .where(and(eq(space.id, spaceId), eq(space.user, data.user.id)))
    .all();

  if (spaceData.length === 0) {
    return {
      success: false,
      error: "You do not own this space",
    };
  }

  try {
    await db.insert(spacesAccess).values({
      spaceId: spaceId,
      userEmail: userEmail,
    });

    revalidatePath("/space/" + spaceId);

    return {
      success: true,
    };
  } catch (e) {
    return {
      success: false,
      error: (e as Error).message,
    };
  }
};

const getTweetData = async (tweetID: string) => {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetID}&lang=en&features=tfw_timeline_list%3A%3Btfw_follower_count_sunset%3Atrue%3Btfw_tweet_edit_backend%3Aon%3Btfw_refsrc_session%3Aon%3Btfw_fosnr_soft_interventions_enabled%3Aon%3Btfw_show_birdwatch_pivots_enabled%3Aon%3Btfw_show_business_verified_badge%3Aon%3Btfw_duplicate_scribes_to_settings%3Aon%3Btfw_use_profile_image_shape_enabled%3Aon%3Btfw_show_blue_verified_badge%3Aon%3Btfw_legacy_timeline_sunset%3Atrue%3Btfw_show_gov_verified_badge%3Aon%3Btfw_show_business_affiliate_badge%3Aon%3Btfw_tweet_edit_frontend%3Aon&token=4c2mmul6mnh`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control": "max-age=0",
      TE: "Trailers",
    },
  });
  console.log(resp.status);
  const data = (await resp.json()) as Tweet;

  return data;
};

export const createMemory = async (input: {
  content: string;
  spaces?: number[];
}): ServerActionReturnType<number> => {
  const data = await auth();

  if (!data || !data.user || !data.user.id) {
    redirect("/signin");
    return { error: "Not authenticated", success: false };
  }

  const type = typeDecider(input.content);

  let pageContent = input.content;
  let metadata: Awaited<ReturnType<typeof getMetaData>>;

  if (!(await limit(data.user.id, type))) {
    return {
      success: false,
      data: 0,
      error: `You have exceeded the limit of ${LIMITS[type as keyof typeof LIMITS]} ${type}s.`,
    };
  }

  let noteId = 0;

  if (type === "page") {
    const response = await fetch("https://md.dhr.wtf/?url=" + input.content, {
      headers: {
        Authorization: "Bearer " + process.env.BACKEND_SECURITY_KEY,
      },
    });
    pageContent = await response.text();

    try {
      metadata = await getMetaData(input.content);
    } catch (e) {
      return {
        success: false,
        error: "Failed to fetch metadata for the page. Please try again later.",
      };
    }
  } else if (type === "tweet") {
    const tweet = await getTweetData(input.content.split("/").pop() as string);
    pageContent = tweetToMd(tweet);
    metadata = {
      baseUrl: input.content,
      description: tweet.text.slice(0, 200),
      image: tweet.user.profile_image_url_https,
      title: `Tweet by ${tweet.user.name}`,
    };
  } else if (type === "note") {
    pageContent = input.content;
    noteId = new Date().getTime();
    metadata = {
      baseUrl: `https://supermemory.ai/note/${noteId}`,
      description: `Note created at ${new Date().toLocaleString()}`,
      image: "https://supermemory.ai/logo.png",
      title: `${pageContent.slice(0, 20)} ${pageContent.length > 20 ? "..." : ""}`,
    };
  } else {
    return {
      success: false,
      data: 0,
      error: "Invalid type",
    };
  }

  let storeToSpaces = input.spaces;

  if (!storeToSpaces) {
    storeToSpaces = [];
  }

  const vectorSaveResponse = await fetch(
    `${process.env.BACKEND_BASE_URL}/api/add`,
    {
      method: "POST",
      body: JSON.stringify({
        pageContent,
        title: metadata.title,
        description: metadata.description,
        url: metadata.baseUrl,
        spaces: storeToSpaces.map((spaceId) => spaceId.toString()),
        user: data.user.id,
        type,
      }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.BACKEND_SECURITY_KEY,
      },
    },
  );

  if (!vectorSaveResponse.ok) {
    const errorData = await vectorSaveResponse.text();
    console.error(errorData);
    return {
      success: false,
      data: 0,
      error: `Failed to save to vector store. Backend returned error: ${errorData}`,
    };
  }

  let contentId: number | undefined;

  const response = (await vectorSaveResponse.json()) as {
    status: string;
    chunkedInput: string;
    message?: string;
  };

  try {
    if (response.status !== "ok") {
      if (response.status === "error") {
        return {
          success: false,
          data: 0,
          error: response.message,
        };
      } else {
        return {
          success: false,
          data: 0,
          error: `Failed to save to vector store. Backend returned error: ${response.message}`,
        };
      }
    }
  } catch (e) {
    return {
      success: false,
      data: 0,
      error: `Failed to save to vector store. Backend returned error: ${e}`,
    };
  }

  const saveToDbUrl =
    (metadata.baseUrl.split("#supermemory-user-")[0] ?? metadata.baseUrl) +
    "#supermemory-user-" +
    data.user.id;

  // Insert into database
  try {
    const insertResponse = await db
      .insert(storedContent)
      .values({
        content: pageContent,
        title: metadata.title,
        description: metadata.description,
        url: saveToDbUrl,
        baseUrl: saveToDbUrl,
        image: metadata.image,
        savedAt: new Date(),
        userId: data.user.id,
        type,
        noteId,
      })
      .returning({ id: storedContent.id });
    revalidatePath("/memories");
    revalidatePath("/home");

    contentId = insertResponse[0]?.id;
  } catch (e) {
    const error = e as Error;
    console.log("Error: ", error.message);

    if (
      error.message.includes(
        "D1_ERROR: UNIQUE constraint failed: storedContent.baseUrl",
      )
    ) {
      return {
        success: false,
        data: 0,
        error: "Content already exists",
      };
    }

    return {
      success: false,
      data: 0,
      error: "Failed to save to database with error: " + error.message,
    };
  }

  if (!contentId) {
    return {
      success: false,
      data: 0,
      error: "Something went wrong while saving the document to the database",
    };
  }

  if (storeToSpaces.length > 0) {
    // Adding the many-to-many relationship between content and spaces
    const spaceData = await db
      .select()
      .from(space)
      .where(
        and(inArray(space.id, storeToSpaces), eq(space.user, data.user.id)),
      )
      .all();

    await Promise.all(
      spaceData.map(async (s) => {
        await db
          .insert(contentToSpace)
          .values({ contentId: contentId, spaceId: s.id });

        await db.update(space).set({ numItems: s.numItems + 1 });
      }),
    );
  }

  return {
    success: true,
    data: 1,
  };
};

export const createChatThread = async (
  firstMessage: string,
): ServerActionReturnType<string> => {
  const data = await auth();

  if (!data || !data.user || !data.user.id) {
    redirect("/signin");
    return { error: "Not authenticated", success: false };
  }

  const thread = await db
    .insert(chatThreads)
    .values({
      firstMessage,
      userId: data.user.id,
    })
    .returning({ id: chatThreads.id })
    .execute();

  console.log(thread);

  if (!thread[0]) {
    return {
      success: false,
      error: "Failed to create chat thread",
    };
  }

  return { success: true, data: thread[0].id };
};

export const createChatObject = async (
  threadId: string,
  chatHistorySoFar: ChatHistory[],
): ServerActionReturnType<boolean> => {
  const data = await auth();

  if (!data || !data.user || !data.user.id) {
    redirect("/signin");
    return { error: "Not authenticated", success: false };
  }

  const lastChat = chatHistorySoFar[chatHistorySoFar.length - 1];
  if (!lastChat) {
    return {
      success: false,
      data: false,
      error: "No chat object found",
    };
  }
  console.log("sources: ", lastChat.answer.sources);

  const saved = await db.insert(chatHistory).values({
    question: lastChat.question,
    answer: lastChat.answer.parts.map((part) => part.text).join(""),
    answerSources: JSON.stringify(lastChat.answer.sources),
    threadId,
  });

  if (!saved) {
    return {
      success: false,
      data: false,
      error: "Failed to save chat object",
    };
  }

  return {
    success: true,
    data: true,
  };
};

export const linkTelegramToUser = async (
  telegramUser: string,
): ServerActionReturnType<boolean> => {
  const data = await auth();

  if (!data || !data.user || !data.user.id) {
    redirect("/signin");
    return { error: "Not authenticated", success: false };
  }

  const user = await db
    .update(users)
    .set({ telegramId: decipher(telegramUser) })
    .where(eq(users.id, data.user.id))
    .execute();

  if (!user) {
    return {
      success: false,
      data: false,
      error: "Failed to link telegram to user",
    };
  }

  return {
    success: true,
    data: true,
  };
};

export const deleteItem = async (id: number) => {
  const data = await auth();

  if (!data || !data.user || !data.user.id) {
    redirect("/signin");
    return { error: "Not authenticated", success: false };
  }

  try {
    const deletedItem = await db
      .delete(storedContent)
      .where(eq(storedContent.id, id))
      .returning();

    if (!deletedItem) {
      return {
        success: false,
        error: "Failed to delete item",
      };
    }

    const actualUrl = deletedItem[0]?.url.split("#supermemory-user-")[0];

    console.log(
      "ACTUAL URL BADBAL;KFJDLKASJFLKDSJFLKDSJFKD LSFJSLKDJF :",
      actualUrl,
    );

    await fetch(`${process.env.BACKEND_BASE_URL}/api/delete`, {
      method: "POST",
      body: JSON.stringify({
        websiteUrl: actualUrl,
        user: data.user.id,
      }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.BACKEND_SECURITY_KEY,
      },
    });

    revalidatePath("/memories");

    return {
      success: true,
      message: "in-sync",
    };
  } catch (error) {
    return {
      success: false,
      error,
      message: "An error occured while saving your canvas",
    };
  }
};

// TODO: also move in vectorize
export const moveItem = async (
  id: number,
  spaces: number[],
  fromSpace?: number | undefined,
): ServerActionReturnType<boolean> => {
  const data = await auth();

  if (!data || !data.user || !data.user.id) {
    redirect("/signin");
    return { error: "Not authenticated", success: false };
  }

  try {
    if (fromSpace) {
      await db
        .delete(contentToSpace)
        .where(
          and(
            eq(contentToSpace.contentId, id),
            eq(contentToSpace.spaceId, fromSpace),
          ),
        );
    }

    const addedItem = await db
      .insert(contentToSpace)
      .values(spaces.map((spaceId) => ({ contentId: id, spaceId })))
      .returning();

    if (!(addedItem.length > 0)) {
      return {
        success: false,
        error: "Failed to move item",
      };
    }

    await db
      .update(space)
      .set({ numItems: sql<number>`numItems + 1` })
      .where(eq(space.id, addedItem[0]?.spaceId!));

    if (!addedItem) {
      return {
        success: false,
        error: "Failed to move item",
      };
    }

    revalidatePath("/memories");

    return {
      success: true,
      data: true,
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
};

export const createCanvas = async () => {
  const data = await auth();

  if (!data || !data.user || !data.user.id) {
    redirect("/signin");
    return { error: "Not authenticated", success: false };
  }

  const canvases = await db
    .select()
    .from(canvas)
    .where(eq(canvas.userId, data.user.id));

  if (canvases.length >= 5) {
    return {
      success: false,
      message: "A user currently can only have 5 canvases",
    };
  }

  const resp = await db
    .insert(canvas)
    .values({ userId: data.user.id })
    .returning({ id: canvas.id });
  redirect(`/canvas/${resp[0]!.id}`);
  // TODO INVESTIGATE: NO REDIRECT INSIDE TRY CATCH BLOCK
  // try {
  //   const resp = await db
  //     .insert(canvas)
  //     .values({ userId: data.user.id }).returning({id: canvas.id});
  //   return redirect(`/canvas/${resp[0]!.id}`);
  // } catch (e: unknown) {
  //   const error = e as Error;
  //   if (
  //     error.message.includes("D1_ERROR: UNIQUE constraint failed: space.name")
  //   ) {
  //     return { success: false, data: 0, error: "Space already exists" };
  //   } else {
  //     return {
  //       success: false,
  //       data: 0,
  //       error: "Failed to create space with error: " + error.message,
  //     };
  //   }
  // }
};

export const SaveCanvas = async ({
  id,
  data,
}: {
  id: string;
  data: string;
}) => {
  console.log({ id, data });
  try {
    await process.env.CANVAS_SNAPS.put(id, data);
    return {
      success: true,
      message: "in-sync",
    };
  } catch (error) {
    return {
      success: false,
      error,
      message: "An error occured while saving your canvas",
    };
  }
};

export const deleteCanvas = async (id: string) => {
  try {
    await process.env.CANVAS_SNAPS.delete(id);
    await db.delete(canvas).where(eq(canvas.id, id));
    return {
      success: true,
      message: "in-sync",
    };
  } catch (error) {
    return {
      success: false,
      error,
      message: "An error occured while saving your canvas",
    };
  }
};

export async function AddCanvasInfo({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  try {
    await db
      .update(canvas)
      .set({ description, title })
      .where(eq(canvas.id, id));
    return {
      success: true,
      message: "info updated successfully",
    };
  } catch (error) {
    return {
      success: false,
      message: "something went wrong :/",
    };
  }
}
