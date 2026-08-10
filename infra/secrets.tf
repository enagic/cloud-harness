# Secret containers only. Terraform never holds the values: it creates each
# secret with a placeholder and ignores subsequent changes, so you populate them
# out of band (see scripts/put-secrets.sh) without the real credential ever
# reaching state or a tfvars file.

locals {
  # Only the OpenAI-compatible path needs a key. Bedrock authenticates with the
  # task role, so the secret is not created at all in that mode.
  create_llm_api_key = var.llm_provider == "openai_compatible"

  secrets = merge(
    {
      jira_api_token = {
        name        = "${local.name_prefix}/jira-api-token"
        description = "Jira Cloud API token for ${var.jira_user_email}"
      }
      # One Bitbucket credential per identity, not one per deployment.
      #
      # The implementer and the reviewer must be separate service accounts:
      # Bitbucket does not count an approval from a pull request's own author
      # towards a minimum-approval merge check, so a shared identity yields a
      # reviewer whose approve call returns 200 while the PR stays unmergeable.
      #
      # In a sandbox the same value can be written to all three. The split is
      # structural so that making them different in production is a change of
      # secret values, not a change of shape.
      bitbucket_token_read = {
        name        = "${local.name_prefix}/bitbucket-token-read"
        description = "Bitbucket read-only token — watcher polling and refiner repo reads"
      }
      bitbucket_token_implementer = {
        name        = "${local.name_prefix}/bitbucket-token-implementer"
        description = "Bitbucket token for the implementer service account — pushes branches, opens PRs"
      }
      bitbucket_token_reviewer = {
        name        = "${local.name_prefix}/bitbucket-token-reviewer"
        description = "Bitbucket token for the reviewer service account — comments and approves. Must differ from the implementer's in production."
      }
    },
    local.create_llm_api_key ? {
      llm_api_key = {
        name        = "${local.name_prefix}/llm-api-key"
        description = "API key for the OpenAI-compatible model endpoint"
      }
    } : {}
  )
}

resource "aws_secretsmanager_secret" "this" {
  for_each = local.secrets

  name                    = each.value.name
  description             = each.value.description
  recovery_window_in_days = 7

  tags = {
    Name = each.value.name
  }
}

resource "aws_secretsmanager_secret_version" "placeholder" {
  for_each = aws_secretsmanager_secret.this

  secret_id     = each.value.id
  secret_string = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
