#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENVIRONMENT=${1:-dev}          # dev | test | prod
PROJECT_NAME=${2:-talentstreamai}

# Load repo-root .env (OPENAI_API_KEY, CLERK_*, DEFAULT_AWS_REGION, etc.) if present.
# Pass ./deploy-aws.sh prod to override ENVIRONMENT / PROJECT_NAME from .env.
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi
ENVIRONMENT=${1:-${ENVIRONMENT:-dev}}
PROJECT_NAME=${2:-${PROJECT_NAME:-talentstreamai}}

echo "🚀 Deploying ${PROJECT_NAME} to ${ENVIRONMENT}..."

# 1. Build Lambda package
cd "$REPO_ROOT"
echo "📦 Building Lambda package..."
(cd backend && uv run deploy.py)

# Check if Lambda package exceeds 50MB and upload to S3 if needed
LAMBDA_ZIP_PATH="backend/lambda-deployment.zip"
if [[ -f "$LAMBDA_ZIP_PATH" ]]; then
  # Get file size in MB
  SIZE_MB=$(du -m "$LAMBDA_ZIP_PATH" | cut -f1)
  echo "📏 Lambda package size: ${SIZE_MB} MB"
  
  if [[ $SIZE_MB -gt 50 ]]; then
    echo "⚠️  Lambda package exceeds 50 MB limit, uploading to S3..."
    
    # Get AWS account ID for S3 bucket naming
    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    
     # Construct S3 bucket name (matches Terraform configuration for Lambda zip storage)
     S3_BUCKET="${PROJECT_NAME}-${ENVIRONMENT}-${AWS_ACCOUNT_ID}"
    
    echo "📤 Uploading to S3 bucket: $S3_BUCKET"
    aws s3 cp "$LAMBDA_ZIP_PATH" "s3://$S3_BUCKET/lambda-deployment.zip"
    
    if [[ $? -eq 0 ]]; then
      echo "✅ Successfully uploaded Lambda package to S3"
    else
      echo "❌ Failed to upload Lambda package to S3"
      exit 1
    fi
  else
    echo "✅ Lambda package is within limits (< 50 MB)"
  fi
else
  echo "⚠️  Lambda package not found at $LAMBDA_ZIP_PATH"
fi

# 2. Terraform workspace & apply
cd terraform
# terraform init -input=false
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION="${AWS_REGION:-${DEFAULT_AWS_REGION:-us-east-1}}"
# Terraform / Lambda (from shell or from sourced .env)
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY in the environment or in $REPO_ROOT/.env}"
: "${CLERK_JWKS_URL:?Set CLERK_JWKS_URL in the environment or in $REPO_ROOT/.env}"
: "${CLERK_ISSUER:?Set CLERK_ISSUER in the environment or in $REPO_ROOT/.env}"
AGENT_MODE="${AGENT_MODE:-llm}"
LLM_BASE_URL="${LLM_BASE_URL:-https://api.openai.com}"
S3_PREFIX="${S3_PREFIX:-uploads/}"
S3_SSE="${S3_SSE:-AES256}"
UPLOAD_STORAGE="${UPLOAD_STORAGE:-s3}"

terraform fmt && terraform init -migrate-state -input=false \
  -backend-config="bucket=talentstreamai-terraform-state-${AWS_ACCOUNT_ID}" \
  -backend-config="key=talentstreamai/${ENVIRONMENT}/terraform.tfstate" \
  -backend-config="region=${AWS_REGION}"

if ! terraform workspace list | grep -q "$ENVIRONMENT"; then
  terraform workspace new "$ENVIRONMENT"
else
  terraform workspace select "$ENVIRONMENT"
fi

cat > lambda-function-vars.tfvars <<EOF
aws_region = "${AWS_REGION}"
openai_api_key = "${OPENAI_API_KEY}"
clerk_jwks_url = "${CLERK_JWKS_URL}"
clerk_issuer = "${CLERK_ISSUER}"
agent_mode = "${AGENT_MODE}"
llm_base_url = "${LLM_BASE_URL}"
s3_prefix = "${S3_PREFIX}"
s3_sse = "${S3_SSE}"
upload_storage = "${UPLOAD_STORAGE}"
EOF

# Use prod.tfvars for production environment
if [ "$ENVIRONMENT" = "prod" ]; then
  TF_APPLY_CMD=(terraform apply -var-file=prod.tfvars -var="project_name=$PROJECT_NAME" -var="environment=$ENVIRONMENT" -auto-approve)
else
  TF_APPLY_CMD=(terraform apply -var-file=lambda-function-vars.tfvars -var="project_name=$PROJECT_NAME" -var="environment=$ENVIRONMENT" -auto-approve)
fi

echo "🎯 Applying Terraform..."
"${TF_APPLY_CMD[@]}"

API_URL=$(terraform output -raw api_gateway_url)
FRONTEND_BUCKET=$(terraform output -raw s3_frontend_bucket)
CUSTOM_URL=$(terraform output -raw custom_domain_url 2>/dev/null || true)

# 3. Build + deploy frontend
cd ../frontend

# Create production environment file with API URL
echo "📝 Setting API URL for production..."
echo "NEXT_PUBLIC_API_URL=$API_URL" > .env.production
echo "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" >> .env.production
echo "CLERK_SECRET_KEY=$CLERK_SECRET_KEY" >> .env.production

npm install
npm run build
aws s3 sync ./out "s3://$FRONTEND_BUCKET/" --delete
cd ..

# 4. Final messages
echo -e "\n✅ Deployment complete!"
echo "🌐 CloudFront URL : $(terraform -chdir=terraform output -raw cloudfront_url)"
if [ -n "$CUSTOM_URL" ]; then
  echo "🔗 Custom domain  : $CUSTOM_URL"
fi
echo "📡 API Gateway    : $API_URL"