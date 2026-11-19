FROM node:22-alpine AS dependencies
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /review
COPY --from=dependencies /build/node_modules/csv-parse ./node_modules/csv-parse
COPY .claude/scripts/soc/artex-csv.mjs .claude/scripts/soc/rbi-artex-review.mjs ./
USER node
ENTRYPOINT ["node", "rbi-artex-review.mjs"]
