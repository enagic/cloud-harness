# One repo for the watcher, one for the base agent image, and one per stack.
#
# The three agents share their code, so they share a base image; what differs
# between stack images is only the language toolchain layered on top. The refiner
# runs the base image directly since it never builds anything.
#
# See local.ecr_repos in locals.tf.

resource "aws_ecr_repository" "this" {
  for_each = local.ecr_repos

  name                 = each.value
  image_tag_mutability = "MUTABLE" # POC pushes :latest; pin to IMMUTABLE + digests for prod

  # A repository with images in it refuses to delete otherwise, which is every
  # repository here after the first `make images`. See disposable_deployment.
  force_delete = var.disposable_deployment

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
