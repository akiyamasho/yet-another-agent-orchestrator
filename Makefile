.PHONY: dep dev build run release test clean

dep:
	npm install

dev:
	npm run dev

build:
	npm run build

run: build
	npm run desktop:open

release:
	npm run dist

test:
	npm run typecheck
	node --test lib/store/snapshot-coordinator.test.cjs electron/codex/app-server-bridge.test.cjs electron/codex/pending-created-threads.test.cjs electron/codex/archive-thread.test.cjs electron/claude/provider.test.cjs electron/pi/cleanup.test.cjs electron/pi/recovery-ipc.test.cjs electron/pi/provider.test.cjs electron/pi/orchestration.test.cjs electron/pi/integration.test.cjs electron/chat/timeline.test.cjs electron/attachments/clipboard-image.test.cjs electron/updater/github-release-updater.test.cjs electron/terminal-runner.test.cjs

clean:
	rm -rf .next out release
