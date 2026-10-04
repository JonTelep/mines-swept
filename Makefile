.PHONY: dev deploy test install

export WRANGLER_SEND_METRICS := false

install:
	npm install

dev: install
	npx wrangler dev --port 8787 --ip 0.0.0.0 --show-interactive-dev-session=false

deploy: install
	npx wrangler deploy

test: install
	node --test --test-concurrency=1 --test-timeout 180000 test/stats.test.js test/game.test.js test/filter.test.js test/finite.test.js test/multiplayer.test.js test/social.test.js
