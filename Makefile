.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

PROJECT_NAME ?= cloud-harness
ENVIRONMENT  ?= poc
AWS_REGION   ?= us-east-1
TAG          ?= latest
CLUSTER      := $(PROJECT_NAME)-$(ENVIRONMENT)
# Read from terraform when available so a new stack needs no Makefile edit.
UNITS         = $(shell cd infra && terraform output -json agent_queue_urls 2>/dev/null | jq -r 'keys[]' 2>/dev/null)

export PROJECT_NAME ENVIRONMENT AWS_REGION TAG

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

# --- Application ------------------------------------------------------------

.PHONY: install
install: ## Install workspace dependencies
	npm install

.PHONY: build
build: ## Compile all TypeScript workspaces
	npm run build

.PHONY: typecheck
typecheck: ## Typecheck without emitting
	npm run typecheck

.PHONY: test
test: ## Run the state machine tests
	npm test

.PHONY: clean
clean: ## Remove build output
	npm run clean

# --- Images -----------------------------------------------------------------

.PHONY: images
images: ## Build and push every image (watcher, agents-base, one per stack)
	./scripts/build-and-push.sh

.PHONY: image-watcher
image-watcher: ## Build and push the watcher image only
	./scripts/build-and-push.sh watcher

.PHONY: image-agents
image-agents: ## Build and push the base + all stack agent images
	./scripts/build-and-push.sh agents-base $(shell cd infra && terraform output -json stacks 2>/dev/null | jq -r '.known[] | "agents-" + .' 2>/dev/null)

.PHONY: image-stack
image-stack: ## Build and push one stack image. STACK=python make image-stack
	@test -n "$(STACK)" || { echo "Set STACK=<name>"; exit 1; }
	./scripts/build-and-push.sh agents-$(STACK)

.PHONY: stacks
stacks: ## Show the stacks this deployment can build and test
	cd infra && terraform output stacks

# --- Infrastructure ---------------------------------------------------------

.PHONY: tf-init
tf-init: ## terraform init
	cd infra && terraform init

.PHONY: tf-fmt
tf-fmt: ## terraform fmt
	cd infra && terraform fmt -recursive

.PHONY: tf-validate
tf-validate: ## terraform validate
	cd infra && terraform validate

.PHONY: plan
plan: ## terraform plan
	cd infra && terraform plan

.PHONY: apply
apply: ## terraform apply
	cd infra && terraform apply

.PHONY: destroy
destroy: ## Tear the stack down
	cd infra && terraform destroy

.PHONY: outputs
outputs: ## Show terraform outputs
	cd infra && terraform output

.PHONY: workflow
workflow: ## Print the Jira columns, label and fields this deployment expects
	cd infra && terraform output jira_workflow

# --- Operations -------------------------------------------------------------

.PHONY: secrets
secrets: ## Populate Secrets Manager values (prompts, nothing echoed)
	./scripts/put-secrets.sh

.PHONY: secrets-from-env
secrets-from-env: ## Populate secrets from .env.local instead of prompting (ENV_FILE=... to override)
	./scripts/put-secrets.sh --from-env $(or $(ENV_FILE),.env.local)

.PHONY: restart-watcher
restart-watcher: ## Force a new watcher deployment (picks up new image/secrets)
	aws ecs update-service --cluster $(CLUSTER) \
		--service $(CLUSTER)-watcher --force-new-deployment >/dev/null
	@echo "watcher redeploying"

.PHONY: logs-watcher
logs-watcher: ## Tail watcher logs
	aws logs tail /ecs/$(CLUSTER)/watcher --follow

.PHONY: logs-refiner
logs-refiner: ## Tail refiner logs
	aws logs tail /ecs/$(CLUSTER)/refiner --follow

.PHONY: logs-agent
logs-agent: ## Tail one agent unit. UNIT=implementer-node make logs-agent
	@test -n "$(UNIT)" || { echo "Set UNIT=<agent>-<stack>, e.g. implementer-node. See: make units"; exit 1; }
	aws logs tail /ecs/$(CLUSTER)/$(UNIT) --follow

.PHONY: units
units: ## List every (agent, stack) unit
	cd infra && terraform output agent_units

.PHONY: queue-depth
queue-depth: ## Show depth of every queue and DLQ, per (agent, stack) unit
	@cd infra && for unit in $(UNITS); do \
		main=$$(terraform output -json agent_queue_urls | jq -r --arg u "$$unit" '.[$$u]'); \
		dlq=$$(terraform output -json agent_dlq_urls | jq -r --arg u "$$unit" '.[$$u]'); \
		visible=$$(aws sqs get-queue-attributes --queue-url "$$main" \
			--attribute-names ApproximateNumberOfMessages \
			--query 'Attributes.ApproximateNumberOfMessages' --output text); \
		inflight=$$(aws sqs get-queue-attributes --queue-url "$$main" \
			--attribute-names ApproximateNumberOfMessagesNotVisible \
			--query 'Attributes.ApproximateNumberOfMessagesNotVisible' --output text); \
		dead=$$(aws sqs get-queue-attributes --queue-url "$$dlq" \
			--attribute-names ApproximateNumberOfMessages \
			--query 'Attributes.ApproximateNumberOfMessages' --output text); \
		printf '%-22s queued=%-4s in-flight=%-4s dlq=%s\n' "$$unit" "$$visible" "$$inflight" "$$dead"; \
	done

.PHONY: redrive
redrive: ## Replay one unit's DLQ onto its queue. UNIT=implementer-node make redrive
	@test -n "$(UNIT)" || { echo "Set UNIT=<agent>-<stack>. See: make units"; exit 1; }
	@cd infra && \
	dlq=$$(terraform output -json agent_dlq_urls | jq -r --arg u "$(UNIT)" '.[$$u]') && \
	arn=$$(aws sqs get-queue-attributes --queue-url "$$dlq" \
		--attribute-names QueueArn --query 'Attributes.QueueArn' --output text) && \
	aws sqs start-message-move-task --source-arn "$$arn"
