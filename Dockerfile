# ── Build stage ───────────────────────────────────────────
FROM golang:1.21-alpine AS builder

WORKDIR /build
COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ .
RUN CGO_ENABLED=0 GOOS=linux go build -o fighter-game-server .

# ── Runtime stage ──────────────────────────────────────────
FROM alpine:latest

RUN apk --no-cache add ca-certificates

# Binary runs from /app/server so that ../client resolves correctly
WORKDIR /app/server
COPY --from=builder /build/fighter-game-server .
COPY client/ /app/client/

EXPOSE 8080
CMD ["./fighter-game-server"]
