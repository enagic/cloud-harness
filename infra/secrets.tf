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
      bitbucket_token = {
        name        = "${local.name_prefix}/bitbucket-token"
        description = "Bitbucket app password or access token used to push branches and open PRs"
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
