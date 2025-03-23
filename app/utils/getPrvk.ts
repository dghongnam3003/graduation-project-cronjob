export const getPrvk = async (
  secretId: string,
  versionId = "latest"
): Promise<string> => {
  const {
    SecretManagerServiceClient,
  } = require("@google-cloud/secret-manager");
  const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
  const client = new SecretManagerServiceClient();
  try {
    // Construct request
    const request = {
      name: `projects/${GCP_PROJECT_ID}/secrets/${secretId}/versions/${versionId}`,
    };
    // Run request
    const [version] = await client.accessSecretVersion(request);
    const privateValue = version.payload.data.toString();
    return privateValue;
  } catch (error) {
    console.log(`Error getting secret ${secretId}`, error);
    throw error;
  }
};
