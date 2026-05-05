variable "name_prefix" {
  type        = string
  description = "Prefix for resource names (e.g. project-env)"
}

variable "account_id" {
  type        = string
  description = "AWS account ID for globally unique bucket naming"
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to S3 resources"
  default     = {}
}
