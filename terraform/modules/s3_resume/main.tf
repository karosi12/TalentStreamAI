resource "aws_s3_bucket" "resume_storage" {
  bucket = "${var.name_prefix}-resume-${var.account_id}"
  tags   = var.tags
}

resource "aws_s3_bucket_public_access_block" "resume_storage" {
  bucket = aws_s3_bucket.resume_storage.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "resume_storage" {
  bucket = aws_s3_bucket.resume_storage.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_object" "resume_uploads_folder" {
  bucket = aws_s3_bucket.resume_storage.id
  key    = "uploads/"
  acl    = "private"
}
