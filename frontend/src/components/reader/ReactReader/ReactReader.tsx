import React, {
    type CSSProperties,
    type ReactNode,
    useRef,
    useState,
} from "react";
import { type SwipeableProps, useSwipeable } from "react-swipeable";
import { EpubView, type IEpubViewProps } from "../EpubView/EpubView";
import { type IEpubViewStyle } from "../EpubView/style";
import {
    ReactReaderStyle as defaultStyles,
    type IReactReaderStyle,
} from "./style";

import { type NavItem } from "epubjs";

type SwipeWrapperProps = {
    children: ReactNode;
    swipeProps: Partial<SwipeableProps>;
};

const SwipeWrapper = ({ children, swipeProps }: SwipeWrapperProps) => {
    const handlers = useSwipeable(swipeProps);
    return (
        <div style={{ height: "100%" }} {...handlers}>
            {children}
        </div>
    );
};

type TocItemProps = {
    data: NavItem;
    setLocation: (value: string) => void;
    styles?: CSSProperties;
};

const TocItem = ({ data, setLocation, styles }: TocItemProps) => (
    <div>
        <button onClick={() => setLocation(data.href)} style={styles}>
            {data.label}
        </button>
        {data.subitems && data.subitems.length > 0 && (
            <div style={{ paddingLeft: 10 }}>
                {data.subitems.map((item, i) => (
                    <TocItem
                        key={i}
                        data={item}
                        styles={styles}
                        setLocation={setLocation}
                    />
                ))}
            </div>
        )}
    </div>
);

export type IReactReaderProps = IEpubViewProps & {
    title?: string;
    showToc?: boolean;
    readerStyles?: IReactReaderStyle;
    epubViewStyles?: IEpubViewStyle;
    swipeable?: boolean;
    isRTL?: boolean;
};

export const ReactReader = ({
    title,
    showToc = true,
    loadingView,
    readerStyles = defaultStyles,
    locationChanged,
    swipeable,
    epubViewStyles,
    isRTL = false,
    tocChanged,
    ...props
}: IReactReaderProps) => {
    const [expandedToc, setExpandedToc] = useState(false);
    const [toc, setToc] = useState<NavItem[]>([]);
    const readerRef = useRef<EpubView>(null);
    const toggleToc = () => {
        setExpandedToc(!expandedToc);
    };

    const handleTocChange = (newToc: NavItem[]) => {
        // Filter out the first item (cover)
        const filteredToc = newToc.slice(1);
        setToc(filteredToc);
        if (tocChanged) {
            tocChanged(filteredToc);
        }
    };

    const handleSetLocation = (loc: string) => {
        setExpandedToc(false);
        if (locationChanged) {
            locationChanged(loc);
        }
    };

    return (
        <div style={readerStyles.container} className="rounded-lg">
            <div
                style={Object.assign(
                    {},
                    readerStyles.readerArea,
                    expandedToc ? readerStyles.containerExpanded : {}
                )}
            >
                {showToc && (
                    <button
                        style={Object.assign(
                            {},
                            readerStyles.tocButton,
                            expandedToc ? readerStyles.tocButtonExpanded : {}
                        )}
                        onClick={toggleToc}
                    >
                        <span
                            style={Object.assign(
                                {},
                                readerStyles.tocButtonBar,
                                readerStyles.tocButtonBarTop
                            )}
                        />
                        <span
                            style={Object.assign(
                                {},
                                readerStyles.tocButtonBar,
                                readerStyles.tocButtonBottom
                            )}
                        />
                    </button>
                )}
                <div style={readerStyles.titleArea}>{title}</div>
                <SwipeWrapper
                    swipeProps={{
                        onTouchStartOrOnMouseDown: ({ event }) =>
                            event.preventDefault(),
                        touchEventOptions: { passive: false },
                        preventScrollOnSwipe: true,
                        trackMouse: true,
                    }}
                >
                    <div style={readerStyles.reader}>
                        <EpubView
                            ref={readerRef}
                            loadingView={
                                loadingView === undefined ? (
                                    <div style={readerStyles.loadingView}>
                                        Loading…
                                    </div>
                                ) : (
                                    loadingView
                                )
                            }
                            epubViewStyles={epubViewStyles}
                            {...props}
                            tocChanged={handleTocChange}
                            locationChanged={locationChanged}
                        />
                        {swipeable && <div style={readerStyles.swipeWrapper} />}
                    </div>
                </SwipeWrapper>
            </div>
            {showToc && (
                <div>
                    <div style={readerStyles.tocArea}>
                        <div style={readerStyles.toc}>
                            {toc.map((item, i) => (
                                <TocItem
                                    data={item}
                                    key={i}
                                    setLocation={handleSetLocation}
                                    styles={readerStyles.tocAreaButton}
                                />
                            ))}
                        </div>
                    </div>
                    {expandedToc && (
                        <div
                            style={readerStyles.tocBackground}
                            onClick={toggleToc}
                        />
                    )}
                </div>
            )}
        </div>
    );
};
