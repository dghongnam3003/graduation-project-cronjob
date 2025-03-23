dev:
	yarn start

start-db:
	docker-compose up -d

serve:
	pm2 start ecosystem.config.js
