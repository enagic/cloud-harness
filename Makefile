.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

PROJECT_NAME ?= cloud-harness
ENVIRONMENT  ?= poc
AWS_REGION   ?= us-east-1
TAG          ?= latest
CLUSTER      := $(PROJECT_NAME)-$(ENVIRONMENT)
AGENTS       := refiner implementer reviewer

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
images: ## Build and push both images to ECR
	./scripts/build-and-push.sh

.PHONY: image-watcher
image-watcher: ## Build and push the watcher image only
	./scripts/build-and-push.sh watcher

.PHONY: image-agents
image-agents: ## Build and push the shared agents image only
	./scripts/build-and-push.sh agents

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
workflow: ## Print the Jira statuses and labels this deployment expects
	cd infra && terraform output jira_workflow

# --- Operations -------------------------------------------------------------

.PHONY: secrets
secrets: ## Populate Secrets Manager values (prompts, nothing echoed)
	./scripts/put-secrets.sh

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

.PHONY: logs-implementer
logs-implementer: ## Tail implementer logs
	aws logs tail /ecs/$(CLUSTER)/implementer --follow

.PHONY: logs-reviewer
logs-reviewer: ## Tail reviewer logs
	aws logs tail /ecs/$(CLUSTER)/reviewer --follow

.PHONY: queue-depth
queue-depth: ## Show depth of every queue and DLQ
	@cd infra && for agent in $(AGENTS); do \
		main=$$(terraform output -json agent_queue_urls | jq -r ".$$agent"); \
		dlq=$$(terraform output -json agent_dlq_urls | jq -r ".$$agent"); \
		visible=$$(aws sqs get-queue-attributes --queue-url "$$main" \
			--attribute-names ApproximateNumberOfMessages \
			--query 'Attributes.ApproximateNumberOfMessages' --output text); \
		inflight=$$(aws sqs get-queue-attributes --queue-url "$$main" \
			--attribute-names ApproximateNumberOfMessagesNotVisible \
			--query 'Attributes.ApproximateNumberOfMessagesNotVisible' --output text); \
		dead=$$(aws sqs get-queue-attributes --queue-url "$$dlq" \
			--attribute-names ApproximateNumberOfMessages \
			--query 'Attributes.ApproximateNumberOfMessages' --output text); \
		printf '%-14s queued=%-4s in-flight=%-4s dlq=%s\n' "$$agent" "$$visible" "$$inflight" "$$dead"; \
	done

.PHONY: redrive
redrive: ## Replay one agent's DLQ onto its main queue. AGENT=implementer make redrive
	@test -n "$(AGENT)" || { echo "Set AGENT=refiner|implementer|reviewer"; exit 1; }
	@cd infra && \
	dlq=$$(terraform output -json agent_dlq_urls | jq -r ".$(AGENT)") && \
	arn=$$(aws sqs get-queue-attributes --queue-url "$$dlq" \
		--attribute-names QueueArn --query 'Attributes.QueueArn' --output text) && \
	aws sqs start-message-move-task --source-arn "$$arn"
