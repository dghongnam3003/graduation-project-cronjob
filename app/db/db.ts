import mongoose from 'mongoose';

// Global process declaration
declare const process: any;

class DB {
  private static instance: DB;
  private isConnected = false;

  private constructor() { }

  public static getInstance(): DB {
    if (!DB.instance) {
      DB.instance = new DB();
    }
    return DB.instance;
  }

  public disconnect(): void {
    if (this.isConnected) {
      mongoose.disconnect();
      this.isConnected = false;
      console.log('Database disconnected');
    }
  }

  public async connect(retryCount = 0, maxRetries = 5) {
    if (this.isConnected) {
      console.log("Database is already connected");
      return;
    }
    
    try {
      console.log("process.env.MONGO_URI: ", process.env.MONGO_URI);
      await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000, // 10 second timeout
        connectTimeoutMS: 10000,
        heartbeatFrequencyMS: 2000,
        maxPoolSize: 5,
      });
      
      // Setup connection event listeners
      mongoose.connection.on('connected', () => {
        console.log('Mongoose connected to MongoDB');
      });
      
      mongoose.connection.on('error', (error) => {
        console.error('Mongoose connection error:', error);
        this.isConnected = false;
      });
      
      mongoose.connection.on('disconnected', () => {
        console.log('Mongoose disconnected from MongoDB');
        this.isConnected = false;
      });
      
      this.isConnected = true;
      console.log('Database connected successfully');
    } catch (error) {
      console.error(`Error connecting to database (attempt ${retryCount + 1}/${maxRetries + 1}):`, error);
      this.isConnected = false;
      
      if (retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff
        console.log(`Retrying database connection in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.connect(retryCount + 1, maxRetries);
      } else {
        console.error('Max retry attempts reached. Database connection failed.');
        throw error;
      }
    }
  }

  public async getConnection(): Promise<mongoose.Connection> {
    await this.connect();
    const connection = mongoose.connection;

    if (!connection) {
      throw new Error('Database connection not established');
    }

    return connection;
  }

  public isHealthy(): boolean {
    return this.isConnected && mongoose.connection.readyState === 1;
  }

  public getConnectionState(): string {
    const states = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };
    return states[mongoose.connection.readyState] || 'unknown';
  }

}

export default DB;
