const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PiMarkdownProvider, parseMarkdown, walkTickets } = require("./provider.cjs");

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "constellation-pi-"));
}

test("discovers only markdown tickets under .tickets and parses frontmatter/checklist progress", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "WORKFLOW.md"), "# Workflow\n", "utf8");
  fs.mkdirSync(path.join(root, ".tickets", "TODO"), { recursive: true });
  const ticketPath = path.join(root, ".tickets", "TODO", "PI-1.md");
  fs.writeFileSync(ticketPath, `---\nid: PI-1\ntitle: Add Pi tickets\nstate: in_progress\npriority: 2\nlabels:\n  - orchestration\n  - pi\n---\n\n## Description\n\nWire markdown tickets into Constellation.\n\n## Acceptance Criteria\n\n- [x] Parse frontmatter\n- [ ] Show progress\n`, "utf8");

  assert.deepEqual(walkTickets(root), [ticketPath]);
  const ticket = parseMarkdown(ticketPath, fs.readFileSync(ticketPath, "utf8"));
  assert.equal(ticket.id, "PI-1");
  assert.equal(ticket.title, "Add Pi tickets");
  assert.equal(ticket.status, "in_progress");
  assert.equal(ticket.cwd, root);
  assert.deepEqual(ticket.labels, ["orchestration", "pi"]);
  assert.deepEqual(ticket.acceptanceCriteria.map((item) => item.completed), [true, false]);
});

test("Pi ticket edits preserve completed acceptance criteria", () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, ".tickets"));
  const ticketPath = path.join(root, ".tickets", "PI-EDIT.md");
  fs.writeFileSync(ticketPath, `# Edit me

## Acceptance criteria

- [x] Keep this complete
- [ ] Finish this later
`, "utf8");
  const provider = new PiMarkdownProvider({ roots: [root] });
  const updated = provider.updateTicket({ filePath: ticketPath, title: "Edited", objective: "Updated objective", acceptanceCriteria: ["Keep this complete", "Finish this later"] });
  assert.deepEqual(updated.acceptanceCriteria.map((item) => item.completed), [true, false]);
  assert.match(fs.readFileSync(ticketPath, "utf8"), /- \[x\] Keep this complete/);
});

test("provider restricts reads to registered project roots", () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, ".tickets"));
  const ticketPath = path.join(root, ".tickets", "PI-2.md");
  fs.writeFileSync(ticketPath, "# Safe ticket\n\n- [ ] Do work\n", "utf8");
  const outside = path.join(tempProject(), ".tickets", "OUT.md");
  fs.mkdirSync(path.dirname(outside));
  fs.writeFileSync(outside, "# Outside\n", "utf8");

  const provider = new PiMarkdownProvider({ roots: [root] });
  assert.equal(provider.snapshot().tickets.length, 1);
  assert.equal(provider.readTicket("PI-2").ticket.filePath, ticketPath);
  assert.throws(() => provider.readTicket(outside), /not found|outside/i);
});
