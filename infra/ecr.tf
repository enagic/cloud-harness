# Two repositories, not four. The three agents ship as one image with three
# entrypoints — they share their clone/model/Jira machinery, so separate images
# would be three copies of identical layers and three build pipelines to keep in
# step. The task definitions select the agent via `command`.

locals {
  ecr_repos = {
    watcher = "${local.name_prefix}/watcher"
    agents  = "${local.name_prefix}/agents"
  }
}

resource "aws_ecr_repository" "this" {
  for_each = local.ecr_repos

  name                 = each.value
  image_tag_mutability = "MUTABLE" # POC pushes :latest; pin to IMMUTABLE + digests for prod

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name = each.value
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the 20 most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}
