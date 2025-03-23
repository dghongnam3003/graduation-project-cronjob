# Pump-Fund Cronjob Service

A backend service for fetching Pump-Fund campaigns and transactions on Solana.

## Prerequisites

- Node.js v16+
- MongoDB

## Installation

1. Clone the repository:
```bash
git clone https://github.com/dghongnam3003/graduation-project-cronjob.git
cd graduation-project-cronjob
```

2. Install dependencies:
```bash
yarn install
```

3. Set up environment variables:

```bash
cp .env.example .env
```

4. Run docker compose

```bash
docker compose up -d
```


- Note: Because this project uses mongo-replica, after running docker, you need to declare replicaset, specifically the steps will be as follows:

  - First, connect to your MongoDB container:
    ```bash
    docker exec -it mongo-replica mongo
    ```
  - Once you're in the MongoDB shell, initate mongo-replica set:
    ```bash
    rs.initiate();
    ```
  - Then run the reconfig command:
    ```bash
    rs.reconfig({
      _id: "rs0",
      members: [{
        _id: 0,
        host: "localhost:27017"
      }]
    }, {force: true})
    ```

5. Run job

```bash
make serve
```

5.1 Run local

```bash
yarn start:campaign
```

