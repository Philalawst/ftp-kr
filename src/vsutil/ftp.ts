
import FtpClientO = require('ftp');
import * as stream from 'stream';
import { File } from 'krfile';

import * as util from '../util/util';
import { FileInfo } from '../util/fileinfo';

import { FileInterface, NOT_CREATED, FILE_NOT_FOUND, DIRECTORY_NOT_FOUND } from "./fileinterface";
import { printMappedError } from '../util/sm';


class FtpClient extends FtpClientO
{
    // list(path: string, useCompression: boolean, callback: (error: Error, listing: Client.ListingElement[]) => void): void;
    // list(path: string, callback: (error: Error, listing: Client.ListingElement[]) => void): void;
    // list(useCompression: boolean, callback: (error: Error, listing: Client.ListingElement[]) => void): void;
    // list(callback: (error: Error, listing: Client.ListingElement[]) => void): void;

	public list(
		path:string|boolean|((error:Error, listing:FtpClientO.ListingElement[])=>void), 
		zcomp?:boolean|((error:Error, listing:FtpClientO.ListingElement[])=>void),
		cb?:(error:Error, listing:FtpClientO.ListingElement[])=>void):void
	{
		var pathcmd:string;
		if (typeof path === 'string')
		{
			pathcmd = '-al ' + path;
			if (typeof zcomp === 'function')
			{
				cb = zcomp;
				zcomp = false;
			}
			else if (typeof zcomp === 'boolean')
			{
				if (!cb) throw Error('Invalid parameter');
			}
			else
			{
				if (!cb) throw Error('Invalid parameter');
				zcomp = false;
			}
		}
		else if (typeof path === 'boolean')
		{
			if (typeof zcomp !== 'function')
			{
				throw Error('Invalid parameter');
			}
			cb = zcomp;
			zcomp = path;
			pathcmd = '-al';
			path = '';
		}
		else
		{
			cb = path;
			zcomp = false;
			pathcmd = '-al';
			path = '';
		}
		if (path.indexOf(' ') === -1)
			return super.list(pathcmd, zcomp, cb);

		const path_ = path;
		const callback = cb;

		// store current path
		this.pwd((err, origpath) => {
			if (err) return callback(err, []);
			// change to destination path
			this.cwd(path_, err => {
				if (err) return callback(err, []);
				// get dir listing
				super.list('-al', false, (err, list) => {
					// change back to original path
					if (err) return this.cwd(origpath, () => callback(err, []));
					this.cwd(origpath, err => {
						if (err) return callback(err, []);
						callback(err, list);
					});
				});
			});
		});
	}

	public terminate()
	{
		const anythis = (<any>this);
		if (anythis._pasvSock)
		{
			if (anythis._pasvSock.writable)
			  	anythis._pasvSock.destroy();
			anythis._pasvSock = undefined;
		}
		if (anythis._socket)
		{
			if (anythis._socket.writable)
				anythis._socket.destroy();
				anythis._socket = undefined;
		}
		anythis._reset();
	}
}

export class FtpConnection extends FileInterface
{
	client:FtpClient|null = null;

	connected():boolean
	{
		return this.client !== null;
	}

	async _connect(password?:string):Promise<void>
	{
		try
		{
			if (this.client) throw Error('Already created');
			const client = this.client = new FtpClient;
			if (this.config.showGreeting)
			{
				client.on('greeting', (msg:string)=>this.log(msg));
			}

			var options:FtpClientO.Options;
			const config = this.config;
			if (config.protocol === 'ftps' || config.secure)
			{
				options = {
					secure: true,
					secureOptions:{
						rejectUnauthorized: false,
						//checkServerIdentity: (servername, cert)=>{}
					}
				};
			}
			else
			{
				options = {};
			}
	
			options.host = config.host;
			options.port = config.port ? config.port : 21;
			options.user = config.username;
			options.password = password;
			
			options = util.merge(options, config.ftpOverride);
			
			return await new Promise<void>((resolve, reject)=>{
				client.on("ready", ()=>{
					if (!client) return reject(Error(NOT_CREATED));
					
					const socket:stream.Duplex = (<any>client)._socket;
					const oldwrite = socket.write;
					socket.write = (str:string)=>oldwrite.call(socket, str, 'binary');
					socket.setEncoding('binary');
					client.binary(err=>{
						if (err) printMappedError(err);
						resolve();
					});
				})
				.on("error", reject)
				.connect(options);
			});
		}
		catch (err)
		{
			if (this.client)
			{
				this.client.terminate();
				this.client = null;
			}
			throw err;
		}
	}

	disconnect():void
	{
		if (this.client)
		{
			this.client.end();
			this.client = null;
		}
	}

	terminate():void
	{
		if (this.client)
		{
			this.client.terminate();
			this.client = null;
		}
	}

	pwd():Promise<string>
	{
		const client = this.client;
		if (!client) return Promise.reject(Error(NOT_CREATED));

		return new Promise((resolve, reject)=>{
			client.pwd((err, path)=>{
				if (err) reject(err);
				else resolve(path);
			});
		});
	}

	static wrapToPromise<T>(callback:(cb:(err:Error, val?:T)=>void)=>void):Promise<T>
	{
		return new Promise<T>((resolve, reject)=>callback((err, val)=>{
			if(err) reject(err);
			else resolve(val);
		}));
	}

	_rmdir(ftppath:string, recursive:boolean):Promise<void>
	{
		const client = this.client;
		if (!client) return Promise.reject(Error(NOT_CREATED));

		return FtpConnection.wrapToPromise<void>(callback=>client.rmdir(ftppath, recursive, callback))
		.catch(e=>{
			if (e.code === 550) e.ftpCode = FILE_NOT_FOUND;
			throw e;
		});
	}

	_mkdir(ftppath:string, recursive:boolean):Promise<void>
	{
		const client = this.client;
		if (!client) return Promise.reject(Error(NOT_CREATED));
		return FtpConnection.wrapToPromise<void>(callback=>client.mkdir(ftppath, recursive, callback));
	}

	_delete(ftppath:string):Promise<void>
	{
		const client = this.client;
		if (!client) return Promise.reject(Error(NOT_CREATED));
		return FtpConnection.wrapToPromise<void>(callback=>client.delete(ftppath, callback))
		.catch(e=>{
			if (e.code === 550) e.ftpCode = FILE_NOT_FOUND;
			throw e;
		});
	}

	_put(localpath:File, ftppath:string):Promise<void>
	{
		const client = this.client;
		if (!client) return Promise.reject(Error(NOT_CREATED));
		return FtpConnection.wrapToPromise<void>(callback=>client.put(localpath.fsPath, ftppath, callback))
		.catch(e=>{
			if (e.code === 553) e.ftpCode = DIRECTORY_NOT_FOUND;
			else if (e.code === 550) e.ftpCode = DIRECTORY_NOT_FOUND;
			throw e;
		});
	}

	_get(ftppath:string):Promise<NodeJS.ReadableStream>
	{
		const client = this.client;
		if (!client) return Promise.reject(Error(NOT_CREATED));
		return FtpConnection.wrapToPromise<NodeJS.ReadableStream>(callback=>client.get(ftppath, callback))
		.catch(e=>{
			if (e.code === 550)
			{
				e.ftpCode = FILE_NOT_FOUND;
			}
			throw e;
		});
	}

	_list(ftppath:string):Promise<FileInfo[]>
	{
		const client = this.client;
		if (!client) return Promise.reject(Error(NOT_CREATED));
		return FtpConnection.wrapToPromise<FtpClientO.ListingElement[]>(callback=>client.list(ftppath, false, callback))
		.then(list=>list.map(from=>{
			const to = new FileInfo;
			to.type = <any>from.type;
			to.name = from.name;
			to.date = +from.date;
			to.size = +from.size;
			to.link = from.target;
			return to;
		}), e=>{
			if (e.code === 550) return [];
			throw e;
		});
	}

	_readlink(fileinfo:FileInfo, ftppath:string):Promise<string>
	{
		if (fileinfo.link === undefined) return Promise.reject(ftppath + ' is not symlink');
		return Promise.resolve(fileinfo.link);
	}

}
