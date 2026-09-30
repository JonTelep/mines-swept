.PHONY: dev deploy test install

export WRANGLER_SEND_METRICS := false

install:
	npm install

dev: install
	npx wrangler dev --port 8787 --ip 0.0.0.0 --show-interactive-dev-session=false

deploy: install
	npx wrangler deploy

test: install
	node --test --test-timeout 180000 test/game.test.js test/multiplayer.test.js
