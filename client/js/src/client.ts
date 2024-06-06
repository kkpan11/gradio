import type {
	ApiData,
	ApiInfo,
	ClientOptions,
	Config,
	DuplicateOptions,
	EndpointInfo,
	JsApiData,
	PredictReturn,
	SpaceStatus,
	Status,
	SubmitReturn,
	UploadResponse,
	client_return
} from "./types";
import { view_api } from "./utils/view_api";
import { upload_files } from "./utils/upload_files";
import { upload, FileData } from "./upload";
import { handle_blob } from "./utils/handle_blob";
import { post_data } from "./utils/post_data";
import { predict } from "./utils/predict";
import { duplicate } from "./utils/duplicate";
import { submit } from "./utils/submit";
import { RE_SPACE_NAME, process_endpoint } from "./helpers/api_info";
import {
	map_names_to_ids,
	resolve_cookies,
	resolve_config,
	get_jwt,
	parse_and_set_cookies
} from "./helpers/init_helpers";
import { check_space_status } from "./helpers/spaces";
import { open_stream } from "./utils/stream";
import { API_INFO_ERROR_MSG, CONFIG_ERROR_MSG } from "./constants";

export class Client {
	app_reference: string;
	options: ClientOptions;

	config: Config | undefined;
	api_info: ApiInfo<JsApiData> | undefined;
	api_map: Record<string, number> = {};
	session_hash: string = Math.random().toString(36).substring(2);
	jwt: string | false = false;
	last_status: Record<string, Status["stage"]> = {};

	private cookies: string | null = null;

	// streaming
	stream_status = { open: false };
	pending_stream_messages: Record<string, any[][]> = {};
	pending_diff_streams: Record<string, any[][]> = {};
	event_callbacks: Record<string, (data?: unknown) => Promise<void>> = {};
	unclosed_events: Set<string> = new Set();
	heartbeat_event: EventSource | null = null;

	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const headers = new Headers(init?.headers || {});
		if (this && this.cookies) {
			headers.append("Cookie", this.cookies);
		}

		return fetch(input, { ...init, headers });
	}

	async stream(url: URL): Promise<EventSource> {
		if (typeof window === "undefined" || typeof EventSource === "undefined") {
			try {
				const EventSourceModule = await import("eventsource");
				return new EventSourceModule.default(url.toString()) as EventSource;
			} catch (error) {
				console.error("Failed to load EventSource module:", error);
				throw error;
			}
		} else {
			return new EventSource(url.toString());
		}
	}

	view_api: () => Promise<ApiInfo<JsApiData>>;
	upload_files: (
		root_url: string,
		files: (Blob | File)[],
		upload_id?: string
	) => Promise<UploadResponse>;
	upload: (
		file_data: FileData[],
		root_url: string,
		upload_id?: string,
		max_file_size?: number
	) => Promise<(FileData | null)[] | null>;
	handle_blob: (
		endpoint: string,
		data: unknown[],
		endpoint_info: EndpointInfo<ApiData | JsApiData>
	) => Promise<unknown[]>;
	post_data: (
		url: string,
		body: unknown,
		additional_headers?: any
	) => Promise<unknown[]>;
	submit: (
		endpoint: string | number,
		data: unknown[] | Record<string, unknown>,
		event_data?: unknown,
		trigger_id?: number | null
	) => SubmitReturn;
	predict: (
		endpoint: string | number,
		data: unknown[] | Record<string, unknown>,
		event_data?: unknown
	) => Promise<PredictReturn>;
	open_stream: () => Promise<void>;
	private resolve_config: (endpoint: string) => Promise<Config | undefined>;
	private resolve_cookies: () => Promise<void>;
	constructor(app_reference: string, options: ClientOptions = {}) {
		this.app_reference = app_reference;
		this.options = options;

		this.view_api = view_api.bind(this);
		this.upload_files = upload_files.bind(this);
		this.handle_blob = handle_blob.bind(this);
		this.post_data = post_data.bind(this);
		this.submit = submit.bind(this);
		this.predict = predict.bind(this);
		this.open_stream = open_stream.bind(this);
		this.resolve_config = resolve_config.bind(this);
		this.resolve_cookies = resolve_cookies.bind(this);
		this.upload = upload.bind(this);
	}

	private async init(): Promise<void> {
		if (
			(typeof window === "undefined" || !("WebSocket" in window)) &&
			!global.WebSocket
		) {
			const ws = await import("ws");
			global.WebSocket = ws.WebSocket as unknown as typeof WebSocket;
		}

		try {
			if (this.options.auth) {
				await this.resolve_cookies();
			}

			await this._resolve_config().then(({ config }) =>
				this._resolve_hearbeat(config)
			);
		} catch (e: any) {
			throw Error(e);
		}

		this.api_info = await this.view_api();
		this.api_map = map_names_to_ids(this.config?.dependencies || []);
	}

	async _resolve_hearbeat(_config: Config): Promise<void> {
		if (_config) {
			this.config = _config;
			if (this.config && this.config.connect_heartbeat) {
				if (this.config.space_id && this.options.hf_token) {
					this.jwt = await get_jwt(
						this.config.space_id,
						this.options.hf_token,
						this.cookies
					);
				}
			}
		}

		if (_config.space_id && this.options.hf_token) {
			this.jwt = await get_jwt(_config.space_id, this.options.hf_token);
		}

		if (this.config && this.config.connect_heartbeat) {
			// connect to the heartbeat endpoint via GET request
			const heartbeat_url = new URL(
				`${this.config.root}/heartbeat/${this.session_hash}`
			);

			// if the jwt is available, add it to the query params
			if (this.jwt) {
				heartbeat_url.searchParams.set("__sign", this.jwt);
			}

			// Just connect to the endpoint without parsing the response. Ref: https://github.com/gradio-app/gradio/pull/7974#discussion_r1557717540
			if (!this.heartbeat_event)
				this.heartbeat_event = await this.stream(heartbeat_url);
		} else {
			this.heartbeat_event?.close();
		}
	}

	static async connect(
		app_reference: string,
		options: ClientOptions = {}
	): Promise<Client> {
		const client = new this(app_reference, options); // this refers to the class itself, not the instance
		await client.init();
		return client;
	}

	close(): void {
		this.heartbeat_event?.close();
	}

	static async duplicate(
		app_reference: string,
		options: DuplicateOptions = {}
	): Promise<Client> {
		return duplicate(app_reference, options);
	}

	private async _resolve_config(): Promise<any> {
		const { http_protocol, host, space_id } = await process_endpoint(
			this.app_reference,
			this.options.hf_token
		);

		const { status_callback } = this.options;
		let config: Config | undefined;

		try {
			config = await this.resolve_config(`${http_protocol}//${host}`);

			if (!config) {
				throw new Error(CONFIG_ERROR_MSG);
			}

			return this.config_success(config);
		} catch (e: any) {
			if (space_id && status_callback) {
				check_space_status(
					space_id,
					RE_SPACE_NAME.test(space_id) ? "space_name" : "subdomain",
					this.handle_space_success
				);
			} else {
				if (status_callback)
					status_callback({
						status: "error",
						message: "Could not load this space.",
						load_status: "error",
						detail: "NOT_FOUND"
					});
				throw Error(e);
			}
		}
	}

	private async config_success(
		_config: Config
	): Promise<Config | client_return> {
		this.config = _config;

		if (typeof window !== "undefined") {
			if (window.location.protocol === "https:") {
				this.config.root = this.config.root.replace("http://", "https://");
			}
		}

		if (this.config.auth_required) {
			return this.prepare_return_obj();
		}

		try {
			this.api_info = await this.view_api();
		} catch (e) {
			console.error(API_INFO_ERROR_MSG + (e as Error).message);
		}

		return this.prepare_return_obj();
	}

	async handle_space_success(status: SpaceStatus): Promise<Config | void> {
		if (!this) {
			throw new Error(CONFIG_ERROR_MSG);
		}
		const { status_callback } = this.options;
		if (status_callback) status_callback(status);
		if (status.status === "running") {
			try {
				this.config = await this._resolve_config();
				if (!this.config) {
					throw new Error(CONFIG_ERROR_MSG);
				}

				const _config = await this.config_success(this.config);

				return _config as Config;
			} catch (e) {
				if (status_callback) {
					status_callback({
						status: "error",
						message: "Could not load this space.",
						load_status: "error",
						detail: "NOT_FOUND"
					});
				}
				throw e;
			}
		}
	}

	public async component_server(
		component_id: number,
		fn_name: string,
		data: unknown[] | { binary: boolean; data: Record<string, any> }
	): Promise<unknown> {
		if (!this.config) {
			throw new Error(CONFIG_ERROR_MSG);
		}

		const headers: {
			Authorization?: string;
			"Content-Type"?: "application/json";
		} = {};

		const { hf_token } = this.options;
		const { session_hash } = this;

		if (hf_token) {
			headers.Authorization = `Bearer ${this.options.hf_token}`;
		}

		let root_url: string;
		let component = this.config.components.find(
			(comp) => comp.id === component_id
		);
		if (component?.props?.root_url) {
			root_url = component.props.root_url;
		} else {
			root_url = this.config.root;
		}

		let body: FormData | string;

		if ("binary" in data) {
			body = new FormData();
			for (const key in data.data) {
				if (key === "binary") continue;
				body.append(key, data.data[key]);
			}
			body.set("component_id", component_id.toString());
			body.set("fn_name", fn_name);
			body.set("session_hash", session_hash);
		} else {
			body = JSON.stringify({
				data: data,
				component_id,
				fn_name,
				session_hash
			});

			headers["Content-Type"] = "application/json";
		}

		if (hf_token) {
			headers.Authorization = `Bearer ${hf_token}`;
		}

		try {
			const response = await this.fetch(`${root_url}/component_server/`, {
				method: "POST",
				body: body,
				headers,
				credentials: "include"
			});

			if (!response.ok) {
				throw new Error(
					"Could not connect to component server: " + response.statusText
				);
			}

			const output = await response.json();
			return output;
		} catch (e) {
			console.warn(e);
		}
	}

	public set_cookies(raw_cookies: string): void {
		this.cookies = parse_and_set_cookies(raw_cookies).join("; ");
	}

	private prepare_return_obj(): client_return {
		return {
			config: this.config,
			predict: this.predict,
			submit: this.submit,
			view_api: this.view_api,
			component_server: this.component_server
		};
	}
}

/**
 * @deprecated This method will be removed in v1.0. Use `Client.connect()` instead.
 * Creates a client instance for interacting with Gradio apps.
 *
 * @param {string} app_reference - The reference or URL to a Gradio space or app.
 * @param {ClientOptions} options - Configuration options for the client.
 * @returns {Promise<Client>} A promise that resolves to a `Client` instance.
 */
export async function client(
	app_reference: string,
	options: ClientOptions = {}
): Promise<Client> {
	return await Client.connect(app_reference, options);
}

/**
 * @deprecated This method will be removed in v1.0. Use `Client.duplicate()` instead.
 * Creates a duplicate of a space and returns a client instance for the duplicated space.
 *
 * @param {string} app_reference - The reference or URL to a Gradio space or app to duplicate.
 * @param {DuplicateOptions} options - Configuration options for the client.
 * @returns {Promise<Client>} A promise that resolves to a `Client` instance.
 */
export async function duplicate_space(
	app_reference: string,
	options: DuplicateOptions
): Promise<Client> {
	return await Client.duplicate(app_reference, options);
}

export type ClientInstance = Client;
