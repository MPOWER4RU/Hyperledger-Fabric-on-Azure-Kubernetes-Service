import { ConnectionProfileManager } from "../common/ConnectionProfileManager";
import { GatewayHelper } from "../common/GatewayHelper";
import { sep as pathSep, isAbsolute as isAbsolutePath } from "path";
import * as Client from "fabric-client";
import * as chalk from "chalk";
import { ObjectToString } from "../common/LogHelper";

export class ChaincodeOperations {
    public async InstallChaincode(
        chaincodeName: string,
        chaincodeVersion: string,
        chaincodePath: string,
        chaincodeType: Client.ChaincodeType,
        peerOrganization: string,
        peerAdminName: string
    ): Promise<void> {
        if (!isAbsolutePath(chaincodePath)) {
            throw new Error("Please provide absolute path to the chaincode code.");
        }

        const systemGoPath = process.env.GOPATH;
        if (chaincodeType == "golang") {
            const pathSegments = chaincodePath.split(pathSep);
            // for golang it is required to have path with 'src'
            const indexOfSrc = pathSegments.lastIndexOf("src");
            if (indexOfSrc < 1 || indexOfSrc >= pathSegments.length - 1) {
                throw new Error(
                    "For golang chaincode path to the chaincode should contain 'src' segment in the middle. E.g. /opt/gopath/src/github.com/chaincode"
                );
            }

            // and the we need to split path to two segments before src and after src (excluding src).
            process.env.GOPATH = pathSegments.slice(0, indexOfSrc).join(pathSep);
            chaincodePath = pathSegments.slice(indexOfSrc + 1).join(pathSep);
        }

        const profile = await new ConnectionProfileManager().getConnectionProfile(peerOrganization);

        const gateway = await GatewayHelper.CreateGateway(peerAdminName, peerOrganization, profile);

        try {
            const peerAdminClient = gateway.getClient();
            const peers = peerAdminClient.getPeersForOrg(peerOrganization);

            if (!peers.length) {
                throw new Error("No one peer found in connection profile");
            }

            console.log("Checking that chaincode is not installed yet...");
            if (await this.CheckIfChaincodeInstalled(chaincodeName, chaincodeVersion, peerAdminClient, peers[0])) {
                console.log("Chaincode with this name and version already installed.");
                return;
            }

            const txId = peerAdminClient.newTransactionID(true);

            const request: Client.ChaincodeInstallRequest = {
                chaincodeId: chaincodeName,
                chaincodePath,
                chaincodeVersion,
                chaincodeType,
                targets: peers, // all peers
                txId
            };

            console.log("Sending request for chaincode installation...");
            const installResponse = await peerAdminClient.installChaincode(request);
            // assert responses
            let success = true;
            installResponse[0].forEach(response => {
                if (response instanceof Error || response.response.status != 200) {
                    success = false;
                    console.log(ObjectToString(response));
                }
            });

            console.log(success ? chalk.green("Chaincode install successful.") : chalk.red("Install failed."));
        } finally {
            gateway.disconnect();

            // just in case return value back.
            if (chaincodeType == "golang") {
                process.env.GOPATH = systemGoPath;
            }
        }
    }

    public async InstantiateChaincode(
        channelName: string,
        chaincodeName: string,
        chaincodeVersion: string,
        func: string | undefined,
        args: string[] | undefined,
        peerOrganization: string,
        peerAdminName: string
    ): Promise<void> {
        const peerProfile = await new ConnectionProfileManager().getConnectionProfile(peerOrganization);
        const gateway = await GatewayHelper.CreateGateway(peerAdminName, peerOrganization, peerProfile);

        try {
            const peerAdminClient = gateway.getClient();
            const peers = peerAdminClient.getPeersForOrg(peerOrganization);

            if (!peers.length) {
                throw new Error("No one peer found in connection profile");
            }

            const peerNode = peers[0];
            console.log("Checking that chaincode is installed...");
            if (!await this.CheckIfChaincodeInstalled(chaincodeName, chaincodeVersion, peerAdminClient, peerNode)) {
                console.error(chalk.red("Chaincode should be installed."));
                return;
            }

            const network = await gateway.getNetwork(channelName);
            const channel = network.getChannel();

            console.log("Checking that chaincode is not instantiated...");
            if (await this.CheckIfChaincodeInstantiated(chaincodeName, chaincodeVersion, channel, peerNode)) {
                console.log(`Chaincode ${chaincodeName} is already instantiated.`);
            }

            const txId = peerAdminClient.newTransactionID(true);

            const instantiateRequest: Client.ChaincodeInstantiateUpgradeRequest = {
                chaincodeId: chaincodeName,
                chaincodeVersion,
                fcn: func,
                args,
                targets: [peerNode],
                txId
            };

            console.log("Sending instantiate proposal request...");
            const instantiateProposalResponse = await channel.sendInstantiateProposal(instantiateRequest);

            let success = true;
            // assert
            instantiateProposalResponse[0].forEach(response => {
                if (response instanceof Error || response.response.status != 200) {
                    success = false;
                    console.log(ObjectToString(response));
                }
            });

            if (!success) {
                console.error(chalk.red("Sending instantiate proposal failed."));
                return;
            }

            const proposal = instantiateProposalResponse[1];
            const proposalResponses = instantiateProposalResponse[0];

            const orderRequest: Client.TransactionRequest = {
                proposal,
                proposalResponses: proposalResponses as Client.ProposalResponse[],
                txId
            };

            console.log("Sending instantiation transaction to be ordered...");
            const orderTransactionResponse = await channel.sendTransaction(orderRequest);

            if (orderTransactionResponse.status != "SUCCESS") {
                success = false;
                console.error(JSON.stringify(orderTransactionResponse));
            }

            console.log(success ? chalk.green("Instantiation successful.") : chalk.red("Instantiation failed."));
        } finally {
            gateway.disconnect();
        }
    }

    public async InvokeChaincode(
        channelName: string,
        chaincodeName: string,
        func: string,
        args: string[],
        clientUserName: string,
        peerOrganization: string
    ): Promise<void> {
        const profile = await new ConnectionProfileManager().getConnectionProfile(peerOrganization);
        const gateway = await GatewayHelper.CreateGateway(clientUserName, peerOrganization, profile);

        try {
            const network = await gateway.getNetwork(channelName);
            // Get the contract from the network.
            const contract = network.getContract(chaincodeName);

            const contractResponse = await contract.submitTransaction(func, ...args);

            console.log(`Chaincode ${chaincodeName} successfully invoked on channel ${channelName}.`);
            if (contractResponse.toString()) {
                console.log(`response from chaincode: ${contractResponse.toString()}`);
            } else {
                console.log(`Got empty response.`);
            }
        } finally {
            gateway.disconnect();
        }
    }

    public async QueryChaincode(
        channelName: string,
        chaincodeName: string,
        func: string,
        args: string[],
        clientUserName: string,
        peerOrganization: string
    ): Promise<void> {
        const profile = await new ConnectionProfileManager().getConnectionProfile(peerOrganization);
        const gateway = await GatewayHelper.CreateGateway(clientUserName, peerOrganization, profile);

        try {
            const network = await gateway.getNetwork(channelName);
            // Get the contract from the network.
            const contract = network.getContract(chaincodeName);
            const contractResponse = await contract.evaluateTransaction(func, ...args);

            console.log(`Chaincode ${chaincodeName} successfully queried on channel ${channelName}.`);
            if (contractResponse.toString()) {
                console.log(`response from chaincode: ${contractResponse.toString()}`);
            } else {
                console.log(`Got empty response.`);
            }
        } finally {
            gateway.disconnect();
        }
    }

    private async CheckIfChaincodeInstalled(chaincodeName: string, chaincodeVersion: string, client: Client, peer: Client.Peer): Promise<boolean> {
        const installedChaincodes = (await client.queryInstalledChaincodes(peer)).chaincodes;

        let installed = false;
        installedChaincodes.forEach(chaincode => {
            installed = installed || chaincode.name == chaincodeName && chaincode.version == chaincodeVersion;
        });

        return installed;
    }

    private async CheckIfChaincodeInstantiated(chaincodeName: string, chaincodeVersion: string, channel: Client.Channel, peer: Client.Peer): Promise<boolean> {
        const instantiatedChaincodes = (await channel.queryInstantiatedChaincodes(peer)).chaincodes;

        let instantiated = false;
        instantiatedChaincodes.forEach(chaincode => {
            instantiated = instantiated || chaincode.name == chaincodeName && chaincode.version == chaincodeVersion;
        });

        return instantiated;
    }
}
