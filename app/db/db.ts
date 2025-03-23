import mongoose from 'mongoose';

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

  public async connect() {
    if (this.isConnected) {
      console.log("Database is already connected");
      return;
    }
    try {
      console.log("process.env.MONGO_URI: ", process.env.MONGO_URI);
      await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      this.isConnected = true;
      console.log('Database connected successfully');
    } catch (error) {
      console.error('Error connecting to database:', error);
      this.isConnected = false;
      throw error;
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

}

export default DB;
