import React, { Component } from "react";
import Epub, { Book } from "epubjs";
import type { NavItem, Contents, Rendition, Location } from "epubjs";
import { EpubViewStyle as defaultStyles, type IEpubViewStyle } from "./style";
import type { RenditionOptions } from "epubjs/types/rendition";
import type { BookOptions } from "epubjs/types/book";

export type RenditionOptionsFix = RenditionOptions & {
    allowPopups: boolean;
};

export type IToc = {
    label: string;
    href: string;
};

export type IEpubViewProps = {
    url: string | ArrayBuffer;
    epubInitOptions?: Partial<BookOptions>;
    epubOptions?: Partial<RenditionOptionsFix>;
    epubViewStyles?: IEpubViewStyle;
    loadingView?: React.ReactNode;
    location: string | number | null;
    locationChanged(value: string): void;
    showToc?: boolean;
    tocChanged?(value: NavItem[]): void;
    getRendition?(rendition: Rendition): void;
    handleKeyPress?(): void;
    handleTextSelected?(cfiRange: string, contents: Contents): void;
};
type IEpubViewState = {
    isLoaded: boolean;
    toc: NavItem[];
};

export class EpubView extends Component<IEpubViewProps, IEpubViewState> {
    state: Readonly<IEpubViewState> = {
        isLoaded: false,
        toc: [],
    };
    viewerRef = React.createRef<HTMLDivElement>();
    location?: string | number | null;
    book?: Book;
    rendition?: Rendition;
    prevPage?: () => void;
    nextPage?: () => void;

    constructor(props: IEpubViewProps) {
        super(props);
        this.location = props.location;
        this.book = this.rendition = this.prevPage = this.nextPage = undefined;
    }

    componentDidMount() {
        this.initBook();
        document.addEventListener("keyup", this.handleKeyPress, false);
    }

    initBook() {
        const { url, tocChanged, epubInitOptions } = this.props;
        if (this.book) {
            this.book.destroy();
        }
        this.book = Epub(url);
        this.book.loaded.navigation.then(({ toc }) => {
            this.setState(
                {
                    isLoaded: true,
                    toc: toc,
                },
                () => {
                    tocChanged && tocChanged(toc);
                    this.initReader();
                }
            );
        });
    }

    componentWillUnmount() {
        if (this.book) {
            this.book.destroy();
        }
        this.book = this.rendition = this.prevPage = this.nextPage = undefined;
        document.removeEventListener("keyup", this.handleKeyPress, false);
    }

    shouldComponentUpdate(nextProps: IEpubViewProps) {
        return (
            !this.state.isLoaded ||
            nextProps.location !== this.props.location ||
            nextProps.url !== this.props.url
        );
    }

    componentDidUpdate(prevProps: IEpubViewProps) {
        if (
            prevProps.location !== this.props.location &&
            this.location !== this.props.location
        ) {
            this.rendition?.display(this.props.location + "");
        }
        if (prevProps.url !== this.props.url) {
            this.initBook();
        }
    }

    initReader() {
        const { toc } = this.state;
        const { location, epubOptions, getRendition } = this.props;
        if (this.viewerRef.current) {
            const node = this.viewerRef.current;
            if (this.book) {
                const rendition = this.book.renderTo(node, {
                    manager: "continuous",
                    flow: "scrolled",
                    width: "100%",
                    height: "100%",
                });
                rendition.themes.register("default", {
                    "*, *::before, *::after": {
                        "font-size": "18px",
                        "line-height": "1.6",
                        "-webkit-font-smoothing": "antialiased",
                    },
                    p: {
                        margin: "1em 0",
                    },
                });
                rendition.themes.select("default");
                this.rendition = rendition;
                getRendition && getRendition(rendition);

                // Skip cover by starting from second TOC item or falling back to spine
                if (
                    typeof location === "string" ||
                    typeof location === "number"
                ) {
                    rendition.display(location + "");
                } else if (toc.length > 0 && toc[0].href) {
                    rendition.display(toc[0].href);
                } else {
                    rendition.display();
                }
            }
        }
    }

    registerEvents() {}

    onLocationChange = (loc: Location) => {
        const { location, locationChanged } = this.props;
        const newLocation = `${loc.start}`;
        if (location !== newLocation) {
            this.location = newLocation;
            locationChanged && locationChanged(newLocation);
        }
    };

    renderBook() {
        const epubViewStyles = {
            ...defaultStyles,
            ...this.props.epubViewStyles,
        };
        return (
            <div ref={this.viewerRef} style={epubViewStyles.view} id="huh" />
        );
    }

    handleKeyPress = (event: KeyboardEvent) => {};

    render() {
        const { isLoaded } = this.state;
        const { loadingView = null } = this.props;
        const epubViewStyles = {
            ...defaultStyles,
            ...this.props.epubViewStyles,
        };
        return (
            <div style={epubViewStyles.viewHolder}>
                {(isLoaded && this.renderBook()) || loadingView}
            </div>
        );
    }
}
