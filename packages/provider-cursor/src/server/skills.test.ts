import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  discoverCursorSkills,
  hasCursorSkillMention,
  probeCursorSkills,
  rewriteCursorSkillMentions,
} from "./skills.ts";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

describe("Cursor skills", () => {
  it("discovers recursive project skills with project precedence", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-home-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const workspace = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-workspace-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const writeSkill = Effect.fn("writeCursorSkill")(function* (
          root: string,
          name: string,
          contents: string,
        ) {
          const skillDirectory = path.join(root, name);
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
        });

        yield* writeSkill(
          path.join(userHome, ".cursor", "skills"),
          "review",
          "---\ndescription: user review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".agents", "skills", "nested"),
          "review",
          "---\nname: Review changes\ndescription: project review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "internal",
          "---\nuser-invocable: false\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "oversized",
          "x".repeat(1_000_001),
        );
        yield* fileSystem.makeDirectory(path.join(userHome, ".codex"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(userHome, ".codex", "skills"),
          "not a directory",
        );

        const skills = yield* discoverCursorSkills(workspace, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "internal",
            path: path.join(workspace, ".cursor", "skills", "internal", "SKILL.md"),
            scope: "project",
            enabled: true,
            userInvocable: false,
          },
          {
            name: "oversized",
            path: path.join(workspace, ".cursor", "skills", "oversized", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
          {
            name: "review",
            displayName: "Review changes",
            description: "project review",
            path: path.join(workspace, ".agents", "skills", "nested", "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ));

  it("skips a skill tree deeper than the limit instead of failing discovery", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDirectory = (prefix: string) =>
          fileSystem
            .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix })
            .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const userHome = yield* tempDirectory("cursor-skills-home-");
        const workspace = yield* tempDirectory("cursor-skills-workspace-");
        const writeSkill = Effect.fn("writeCursorSkill")(function* (directory: string) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), "---\n---\n");
        });
        const userRoot = path.join(userHome, ".claude", "skills");
        // The root is depth 0, so `deep-skill` sits at the depth limit and `below` past it.
        const atLimit = path.join(
          userRoot,
          "deep",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
          "deep-skill",
        );

        yield* writeSkill(path.join(workspace, ".agents", "skills", "review"));
        yield* writeSkill(atLimit);
        yield* writeSkill(path.join(atLimit, "below"));
        yield* writeSkill(path.join(userRoot, "later"));

        const expected = [
          {
            name: "deep-skill",
            path: path.join(atLimit, "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "later",
            path: path.join(userRoot, "later", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "review",
            path: path.join(workspace, ".agents", "skills", "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ];
        expect(yield* discoverCursorSkills(workspace, { HOME: userHome })).toEqual(expected);
        expect(yield* probeCursorSkills(workspace, { HOME: userHome })).toEqual(expected);
      }),
    ));

  it("still fails discovery when a root holds more entries than the scan allows", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem.makeTempDirectoryScoped({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-home-",
        });
        const root = path.join(userHome, ".cursor", "skills");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* Effect.forEach(
          Array.from({ length: 10_001 }, (_, index) => path.join(root, `entry-${index}`)),
          (file) => fileSystem.writeFileString(file, ""),
          { concurrency: 64, discard: true },
        );

        const error = yield* Effect.flip(probeCursorSkills(undefined, { HOME: userHome }));
        expect(error.message).toContain("scan-budget-exhausted");
      }),
    ));

  it.skipIf(!symlinksSupported)(
    "treats a symlinked skill outside the root as a package boundary",
    async () =>
      await runNode(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const userHome = yield* fileSystem.makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-home-",
          });
          const workspace = yield* fileSystem
            .makeTempDirectoryScoped({
              directory: NodeOS.tmpdir(),
              prefix: "cursor-skills-workspace-",
            })
            .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
          const library = yield* fileSystem.makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-library-",
          });
          const writeSkill = Effect.fn("writeCursorSkill")(function* (
            directory: string,
            contents: string,
          ) {
            yield* fileSystem.makeDirectory(directory, { recursive: true });
            yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), contents);
          });

          // A skill package managed in a config repo and installed by symlink.
          // Its own SKILL.md must be discovered under the link name, but nothing
          // below the target may be walked.
          yield* writeSkill(path.join(library, "shared-review"), "---\ndescription: shared\n---\n");
          yield* writeSkill(path.join(library, "shared-review", "hidden"), "---\n---\n");
          const root = path.join(workspace, ".cursor", "skills");
          yield* fileSystem.makeDirectory(root, { recursive: true });
          yield* fileSystem.symlink(path.join(library, "shared-review"), path.join(root, "review"));

          const skills = yield* discoverCursorSkills(workspace, { HOME: userHome });
          expect(skills).toEqual([
            {
              name: "review",
              description: "shared",
              path: path.join(root, "review", "SKILL.md"),
              scope: "project",
              enabled: true,
            },
          ]);
          expect(
            (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
          ).toBe("Success");
        }),
      ),
  );

  it("rewrites only discovered skill mentions into Cursor slash invocations", () => {
    const skills = new Map([
      ["review", { name: "review", path: "/repo/.cursor/skills/review/SKILL.md", enabled: true }],
    ]);
    expect(hasCursorSkillMention("use $Review_Pr:V2 here")).toBe(true);
    expect(hasCursorSkillMention("please $review this")).toBe(true);
    expect(rewriteCursorSkillMentions("use $review, keep $HOME and 5$review", skills)).toBe(
      "use $review, keep $HOME and 5$review",
    );
    expect(rewriteCursorSkillMentions("please $review this", skills)).toBe("please /review this");
  });
  it("detects and invokes digit-leading Cursor skills without rewriting money", () => {
    const skills = new Map(
      ["2spec", "20k", "100M", "1e6"].map((name) => [
        name,
        { name, path: `/repo/.cursor/skills/${name}/SKILL.md`, enabled: true },
      ]),
    );
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(rewriteCursorSkillMentions("use $2spec here", skills)).toBe("use /2spec here");
    expect(rewriteCursorSkillMentions("use $2spec here", new Map())).toBe("use $2spec here");
    for (const text of [
      "pay $20 tomorrow",
      "budget $20k here",
      "cost $100M total",
      "limit $1e6 here",
    ]) {
      expect(hasCursorSkillMention(text)).toBe(false);
      expect(rewriteCursorSkillMentions(text, skills)).toBe(text);
    }
  });
  it("points Cursor at the SKILL.md of mentioned skills it hides from the model", () => {
    const skills = new Map([
      ["review", { name: "review", path: "/repo/.cursor/skills/review/SKILL.md", enabled: true }],
      [
        "deploy",
        {
          name: "deploy",
          path: "/repo/.agents/skills/deploy/SKILL.md",
          enabled: true,
          userInvocationOnly: true,
        },
      ],
      [
        "poteto-mode",
        {
          name: "poteto-mode",
          path: "/home/user/.cursor/skills/poteto-mode/SKILL.md",
          enabled: true,
          userInvocationOnly: true,
        },
      ],
    ]);
    expect(rewriteCursorSkillMentions("please $review this", skills)).toBe("please /review this");
    expect(
      rewriteCursorSkillMentions(
        "use $poteto-mode to $review then $deploy and $poteto-mode again, not $unknown",
        skills,
      ),
    ).toBe(
      [
        "use /poteto-mode to /review then /deploy and /poteto-mode again, not $unknown",
        "",
        '<invoked_skill name="poteto-mode" path="/home/user/.cursor/skills/poteto-mode/SKILL.md">The user invoked this skill. Read the SKILL.md at this path and follow it.</invoked_skill>',
        '<invoked_skill name="deploy" path="/repo/.agents/skills/deploy/SKILL.md">The user invoked this skill. Read the SKILL.md at this path and follow it.</invoked_skill>',
      ].join("\n"),
    );
    const awkwardHome = new Map([
      [
        "deploy",
        {
          name: "deploy",
          path: '/home/R&D "lab" <x>/.cursor/skills/deploy/SKILL.md',
          enabled: true,
          userInvocationOnly: true,
        },
      ],
    ]);
    expect(rewriteCursorSkillMentions("$deploy", awkwardHome)).toBe(
      [
        "/deploy",
        "",
        '<invoked_skill name="deploy" path="/home/R&amp;D &quot;lab&quot; &lt;x>/.cursor/skills/deploy/SKILL.md">The user invoked this skill. Read the SKILL.md at this path and follow it.</invoked_skill>',
      ].join("\n"),
    );
  });
});
