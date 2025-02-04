# minesswept
Mines Swept; a social experiment

## Setup with dockercompose

1. Clone the repository
2. Run `docker-compose up --build`

## Accessing the app

The app will be available at `http://localhost:5000`
Backend will be available at `http://localhost:3000`

## Stopping the app

1. Run `docker-compose down`

# Local Setup
## Setting up the backend

1. Run `cd backend`
2. Run `npm init -y`
3. Run `npm install express socket.io cors nodemon`
4. Run `npm install nodemon --save-dev`


## Setting up the frontend

1. Run `cd frontend`
2. Run `npx create-react-app .`
3. Run `npm install socket.io-client --save`

## Running the app locally

1. Run `cd backend`
2. Run `npm run dev`
3. Run `cd ../frontend`
4. Run `npm start`




