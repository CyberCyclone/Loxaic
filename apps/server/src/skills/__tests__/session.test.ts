import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray, sql } from "@loxaic/db";
import { conversations, messages, user, userPrefs } from "@loxaic/db/schema";
import type { ContentBlock, StreamEventKind } from "@loxaic/types";
import { __setTestSkillsForTest, type CatalogSkill } from "../catalog.ts";
import { prepareRunSkills, type SkillCatalogSnapshot } from "../session.ts";
import { getSkillUsage, recordSkillUse } from "../usage.ts";

/**
 * A conversation's skills over its life, against the database: frozen on the
 * first run, a change announced on the next message and only once, a "/name"
 * put on the row it was typed in (and only once, a retry answers the same
 * row), and the person's use counted.
 */
const owner = `test-skills-${uuid()}`;
const convIds: string[] = [];

beforeAll(async () => {
  await db.insert(user).values({
    id: owner, name: "Skills", email: `${owner}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
});

afterEach(() => {
  __setTestSkillsForTest([]);
});

afterAll(async () => {
  if (convIds.length) {
    await db.delete(messages).where(inArray(messages.conversationId, convIds));
    await db.delete(conversations).where(inArray(conversations.id, convIds));
  }
  await db.delete(userPrefs).where(eq(userPrefs.userId, owner));
  await db.delete(user).where(eq(user.id, owner));
});

async function conversationWith(text: string): Promise<{ convId: string; msgId: string }> {
  const [conv] = await db.insert(conversations).values({ ownerId: owner, title: "skills", kind: "chat" }).returning();
  convIds.push(conv.id);
  const msgId = await addMessage(conv.id, text);
  return { convId: conv.id, msgId };
}

async function addMessage(convId: string, text: string): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({ id: uuid(), conversationId: convId, authorType: "user", authorUserId: owner, content: [{ kind: "text", text }], status: "complete", lamport: Date.now() })
    .returning();
  return row.id;
}

function recorder() {
  const events: StreamEventKind[] = [];
  return { events, producer: { emit: (e: StreamEventKind) => { events.push(e); } } };
}

async function contentOf(id: string): Promise<ContentBlock[]> {
  const row = await db.query.messages.findFirst({ where: eq(messages.id, id) });
  return (row?.content ?? []) as ContentBlock[];
}

async function snapshotOf(convId: string): Promise<SkillCatalogSnapshot> {
  const row = await db.query.conversations.findFirst({ where: eq(conversations.id, convId) });
  return row?.skillCatalog as SkillCatalogSnapshot;
}

const mine = (body: string): CatalogSkill => ({
  name: "house-style", description: "How we write.", source: "user", body, modelInvocable: true,
});

describe("prepareRunSkills", () => {
  it("freezes the list on the first run and offers the tool from it", async () => {
    const { convId, msgId } = await conversationWith("hello");
    const { events, producer } = recorder();
    const skills = await prepareRunSkills({ convId, userId: owner, userMsgId: msgId, front: "0", producer });
    expect(skills.listing?.map((s) => s.name)).toContain("code-review");
    expect(skills.listing?.map((s) => s.name)).not.toContain("compact");
    expect(skills.find("debug")?.body).toContain("# Debug");
    expect(skills.find("compact")).toBeUndefined();
    expect((await snapshotOf(convId)).base.map((s) => s.name)).toEqual(skills.listing?.map((s) => s.name));
    expect(events).toEqual([]);
    expect(await contentOf(msgId)).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("announces a skill added later on the next message, once, and keeps listing the frozen list", async () => {
    const { convId, msgId } = await conversationWith("first");
    const { producer } = recorder();
    const frozen = await prepareRunSkills({ convId, userId: owner, userMsgId: msgId, front: "0", producer });

    __setTestSkillsForTest([mine("Use short sentences.")]);
    const second = await addMessage(convId, "second");
    const rec = recorder();
    const next = await prepareRunSkills({ convId, userId: owner, userMsgId: second, front: "0", producer: rec.producer });
    expect(next.listing).toEqual(frozen.listing);
    expect(next.find("house-style")?.body).toBe("Use short sentences.");
    const blocks = await contentOf(second);
    expect(blocks[1]).toMatchObject({ kind: "skills_update", summary: "Skills changed: added house-style" });
    expect(rec.events).toEqual([{ kind: "skills.update", message_id: second, summary: "Skills changed: added house-style" }]);

    const third = await addMessage(convId, "third");
    await prepareRunSkills({ convId, userId: owner, userMsgId: third, front: "0", producer: recorder().producer });
    expect(await contentOf(third)).toEqual([{ kind: "text", text: "third" }]);

    __setTestSkillsForTest([mine("Use long sentences.")]);
    const fourth = await addMessage(convId, "fourth");
    await prepareRunSkills({ convId, userId: owner, userMsgId: fourth, front: "0", producer: recorder().producer });
    expect((await contentOf(fourth))[1]).toMatchObject({ kind: "skills_update", summary: "Skills changed: changed house-style" });

    // A compaction moves the front: the tool takes the live list, and says nothing.
    const fifth = await addMessage(convId, "fifth");
    const folded = await prepareRunSkills({ convId, userId: owner, userMsgId: fifth, front: "99", producer: recorder().producer });
    expect(folded.listing?.map((s) => s.name)).toContain("house-style");
    expect(await contentOf(fifth)).toEqual([{ kind: "text", text: "fifth" }]);
    expect((await snapshotOf(convId)).latest).toBeUndefined();
  });

  it("writes a notice and the record that it was given together, or neither", async () => {
    // "The model was told" and the notice that tells it are one fact. Written
    // apart, a failure between them repeated the notice on every later turn
    // (and a retry added a second copy to its row), or lost it for good.
    const { convId, msgId } = await conversationWith("first");
    const frozen = await prepareRunSkills({ convId, userId: owner, userMsgId: msgId, front: "0", producer: recorder().producer });
    __setTestSkillsForTest([mine("Use short sentences.")]);

    // The database refuses to record the snapshot for this conversation, as a
    // transient failure would. A trigger, because `db` is a proxy no spy
    // reaches, scoped to this row so parallel suites are untouched.
    const name = `fail_skills_${convId.replaceAll("-", "_")}`;
    await db.execute(
      sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'snapshot write failed'; END $$;
        CREATE TRIGGER ${name} BEFORE UPDATE ON conversations FOR EACH ROW
        WHEN (NEW.id = '${convId}') EXECUTE FUNCTION ${name}();`),
    );
    const second = await addMessage(convId, "second");
    const rec = recorder();
    let failed;
    try {
      failed = await prepareRunSkills({ convId, userId: owner, userMsgId: second, front: "0", producer: rec.producer });
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${name} ON conversations; DROP FUNCTION ${name}();`));
    }
    // Nothing written, nothing said, and the tool still offered as before, so
    // the front of the prompt does not move.
    expect(await contentOf(second)).toEqual([{ kind: "text", text: "second" }]);
    expect(rec.events).toEqual([]);
    expect((await snapshotOf(convId)).latest).toBeUndefined();
    expect(failed.listing).toEqual(frozen.listing);

    // The next run says it, once.
    const third = await addMessage(convId, "third");
    await prepareRunSkills({ convId, userId: owner, userMsgId: third, front: "0", producer: recorder().producer });
    expect((await contentOf(third)).filter((b) => b.kind === "skills_update")).toHaveLength(1);
    const fourth = await addMessage(convId, "fourth");
    await prepareRunSkills({ convId, userId: owner, userMsgId: fourth, front: "0", producer: recorder().producer });
    expect(await contentOf(fourth)).toEqual([{ kind: "text", text: "fourth" }]);
  });

  it("puts a /name skill's instructions on the row it was typed in, once, and counts the use", async () => {
    const { convId, msgId } = await conversationWith("/debug the login page");
    const before = (await getSkillUsage(owner)).debug?.count ?? 0;
    const rec = recorder();
    await prepareRunSkills({ convId, userId: owner, userMsgId: msgId, front: "0", producer: rec.producer });
    const blocks = await contentOf(msgId);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ kind: "skill", name: "debug", source: "builtin" });
    expect((blocks[1] as { text: string }).text).toMatch(/^The user invoked the "debug" skill/);
    expect(rec.events).toEqual([{ kind: "skill.invoked", message_id: msgId, name: "debug", source: "builtin" }]);
    expect((await getSkillUsage(owner)).debug?.count).toBe(before + 1);

    // A retry runs again on the same row.
    await prepareRunSkills({ convId, userId: owner, userMsgId: msgId, front: "0", producer: recorder().producer });
    expect(await contentOf(msgId)).toHaveLength(2);
    expect((await getSkillUsage(owner)).debug?.count).toBe(before + 1);
  });

  it("leaves /compact and an unknown name as ordinary text", async () => {
    for (const text of ["/compact keep it", "/no-such-skill hi"]) {
      const { convId, msgId } = await conversationWith(text);
      await prepareRunSkills({ convId, userId: owner, userMsgId: msgId, front: "0", producer: recorder().producer });
      expect(await contentOf(msgId)).toEqual([{ kind: "text", text }]);
    }
  });

  it("gives a sub-agent its parent owner's live list and stores nothing", async () => {
    const { convId: parent } = await conversationWith("parent");
    const [child] = await db.insert(conversations).values({ ownerId: owner, title: "child", kind: "subagent", parentConversationId: parent }).returning();
    convIds.push(child.id);
    const childMsg = await addMessage(child.id, "/debug a task");
    __setTestSkillsForTest([mine("x")]);
    const skills = await prepareRunSkills({ convId: child.id, userId: owner, userMsgId: childMsg, front: "", producer: recorder().producer, parentConvId: parent });
    expect(skills.listing?.map((s) => s.name)).toContain("house-style");
    expect(await snapshotOf(child.id)).toBeNull();
    expect(await contentOf(childMsg)).toHaveLength(1);
  });
});

describe("recordSkillUse", () => {
  it("counts in one statement, so racing uses are all kept", async () => {
    const name = `race-${uuid().slice(0, 6)}`;
    await Promise.all(Array.from({ length: 8 }, () => recordSkillUse(owner, name)));
    expect((await getSkillUsage(owner))[name]?.count).toBe(8);
  });
});
