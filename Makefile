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
	node --test electron/codex/app-server-bridge.test.cjs electron/claude/provider.test.cjs

clean:
	rm -rf .next out release
