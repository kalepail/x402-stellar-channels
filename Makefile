.PHONY: all build test lint fmt typecheck check ci

all: check

# ── Build ─────────────────────────────────────────────────────────────────────

build: build-contract

build-contract:
	cd contract && cargo build

# ── Test ──────────────────────────────────────────────────────────────────────

test: test-contract test-demo

test-contract:
	cd contract && cargo test --features testutils

test-demo:
	cd demo && pnpm test

# ── Lint ──────────────────────────────────────────────────────────────────────

lint: lint-contract lint-demo

lint-contract:
	cd contract && cargo clippy --tests -- -D warnings

lint-demo:
	cd demo && pnpm lint

# ── Format ────────────────────────────────────────────────────────────────────

fmt: fmt-contract fmt-demo

fmt-contract:
	cd contract && cargo fmt --check

fmt-demo:
	cd demo && pnpm fmt:check

# ── Typecheck ─────────────────────────────────────────────────────────────────

typecheck:
	cd demo && pnpm typecheck

# ── All checks (mirrors CI) ───────────────────────────────────────────────────

check: lint fmt typecheck test

ci: check
